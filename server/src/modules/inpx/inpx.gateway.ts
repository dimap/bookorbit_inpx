import { Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { OnGatewayConnection, OnGatewayDisconnect, OnGatewayInit, SubscribeMessage, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import type { AuthenticationMethod, InpxImportCompletedEvent, InpxImportProgressEvent } from '@bookorbit/types';
import { AuthService } from '../auth/auth.service';
import { rejectSocketConnection } from '../../common/utils/ws-auth.utils';
import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import { InpxProgressStore } from './inpx-progress.store';

@WebSocketGateway({ namespace: '/inpx', cors: { credentials: true } })
export class InpxGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() server: Server;
  private readonly logger = new Logger(InpxGateway.name);
  private readonly clientOrigin: string;

  constructor(
    private readonly jwtService: JwtService,
    private readonly authService: AuthService,
    private readonly progressStore: InpxProgressStore,
    config: ConfigService,
  ) {
    this.clientOrigin = config.get<string>('app.appUrl') ?? 'http://localhost:5173';
  }

  afterInit(server: Server): void {
    if (!server.engine?.opts) return;
    server.engine.opts.cors = {
      ...(server.engine.opts.cors ?? {}),
      origin: this.clientOrigin,
      credentials: true,
    };
  }

  async handleConnection(client: Socket): Promise<void> {
    try {
      const token = client.handshake.auth?.token as string | undefined;
      if (!token) throw new UnauthorizedException('No token provided');
      const payload = this.jwtService.verify<{ sub: number; ver: number; amr?: AuthenticationMethod }>(token, { algorithms: ['HS256'] });
      const user = await this.authService.validateUser(payload.sub, payload.ver, payload.amr ?? 'legacy');
      if (!user) throw new UnauthorizedException('User not found or token revoked');
      (client.data as Record<string, unknown>).user = user;
      await client.join(`user:${user.id}`);
    } catch (err) {
      this.logger.warn(
        `[inpx.ws_connection] [fail] socketId=${client.id} errorClass=${err instanceof Error ? err.name : 'Error'} error="${sanitizeLogValue(err instanceof Error ? err.message : String(err))}" - websocket rejected`,
      );
      rejectSocketConnection(client, err);
    }
  }

  handleDisconnect(client: Socket): void {
    this.logger.debug(`[inpx.ws_connection] [end] socketId=${client.id} - websocket disconnected`);
  }

  @SubscribeMessage('subscribe:library')
  handleSubscribeLibrary(client: Socket, libraryId: number): void {
    void client.join(`library:${libraryId}`);
    for (const event of this.progressStore.getForLibrary(libraryId)) {
      client.emit('inpx:progress', event);
    }
  }

  emitProgress(event: InpxImportProgressEvent): void {
    this.server?.to(`library:${event.libraryId}`).emit('inpx:progress', event);
  }

  emitCompleted(event: InpxImportCompletedEvent): void {
    this.server?.to(`library:${event.libraryId}`).emit('inpx:completed', event);
  }
}
