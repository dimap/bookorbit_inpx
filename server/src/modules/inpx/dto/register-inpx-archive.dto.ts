import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class RegisterInpxArchiveDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(4096)
  path: string;
}
