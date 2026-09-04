import { parseSevenZipList } from './sevenzip-cli';

describe('parseSevenZipList', () => {
  it('parses file paths and sizes from 7z -slt output and skips directories', () => {
    const stdout = [
      'Scanning the drive for archives:',
      '1 file, 1052654 bytes (1028 KiB)',
      'Listing archive: /books/fb2-000007-788888_lost.7z',
      '--',
      'Path = fb2-000007-788888_lost.7z',
      'Type = 7z',
      'Physical Size = 1052654',
      'Method = PPMD',
      'Blocks = 10',
      '----------',
      'Path = 125784.fb2',
      'Size = 6442381',
      'Packed Size = 12000',
      '----------',
      'Path = 784382.fb2',
      'Size = 1024',
      '----------',
      'Path = somedir/',
      'Folder = +',
      'Size = 0',
      '----------',
      'Path = somedir/788867.fb2',
      'Size = 2048',
    ].join('\n');

    expect(parseSevenZipList(stdout)).toEqual([
      { name: '125784.fb2', size: 6442381 },
      { name: '784382.fb2', size: 1024 },
      { name: 'somedir/788867.fb2', size: 2048 },
    ]);
  });
});
