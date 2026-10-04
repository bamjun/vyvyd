import {statSync} from 'node:fs';
import {homedir} from 'node:os';
import path from 'node:path';

export const BROWSER_NOT_FOUND_MESSAGE = 'Chrome 또는 Edge 설치 경로를 확인할 수 없습니다. 브라우저를 설치하거나 CHROME_EXECUTABLE에 실행 파일 경로를 지정해 주세요.';

const regularFile = (filename) => {
  try {return statSync(filename).isFile();} catch {return false;}
};

export function getBrowserExecutable({platform = process.platform, env = process.env,
  homeDirectory = homedir(), isFile = regularFile} = {}) {
  // An explicit path must not silently select a different browser when invalid.
  if (env.CHROME_EXECUTABLE) return isFile(env.CHROME_EXECUTABLE) ? env.CHROME_EXECUTABLE : undefined;
  const paths = platform === 'win32' ? path.win32 : path.posix;
  let candidates;
  let commands;
  if (platform === 'win32') {
    candidates = [env.ProgramFiles || 'C:/Program Files', env['ProgramFiles(x86)'] || 'C:/Program Files (x86)',
      env.LOCALAPPDATA].filter(Boolean).flatMap((directory) => [
      paths.join(directory, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      paths.join(directory, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    ]);
    commands = ['chrome.exe', 'msedge.exe', 'chromium.exe'];
  } else if (platform === 'darwin') {
    candidates = ['/Applications', paths.join(homeDirectory, 'Applications')].flatMap((directory) => [
      paths.join(directory, 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome'),
      paths.join(directory, 'Microsoft Edge.app', 'Contents', 'MacOS', 'Microsoft Edge'),
      paths.join(directory, 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
    ]);
    commands = ['google-chrome', 'chromium', 'microsoft-edge'];
  } else if (platform === 'linux') {
    candidates = ['/usr/bin/google-chrome-stable', '/usr/bin/google-chrome', '/usr/bin/chromium',
      '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable',
      '/opt/google/chrome/chrome', '/opt/microsoft/msedge/msedge', '/snap/bin/chromium'];
    commands = ['google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser',
      'microsoft-edge', 'microsoft-edge-stable'];
  } else return undefined;
  const searchPath = env.PATH ?? env.Path ?? env.path ?? '';
  for (const directory of searchPath.split(platform === 'win32' ? ';' : ':').filter(Boolean)) {
    candidates.push(...commands.map((command) => paths.join(directory, command)));
  }
  return [...new Set(candidates)].find(isFile);
}
