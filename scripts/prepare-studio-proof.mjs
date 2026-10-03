import {copyFile, mkdir} from 'node:fs/promises';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fontRoot = path.dirname(require.resolve('@fontsource/noto-sans-kr/package.json'));
const target = path.join(root, 'public', 'studio-proof');
await mkdir(target, {recursive: true});
await copyFile(path.join(fontRoot, 'files', 'noto-sans-kr-korean-700-normal.woff2'), path.join(target, 'NotoSansKR.woff2'));
await copyFile(path.join(fontRoot, 'LICENSE'), path.join(target, 'FONT-LICENSE.txt'));
console.log('Studio proof assets prepared (Noto Sans KR, SIL OFL).');
