import path from 'node:path';

export const STORAGE_STATE_FILENAME = '.agents-chat-storage.json';
export const DATA_DIRECTORY_NAME = '.data';
export const CHAT_DATABASE_FILENAME = 'chats.db';
export const CONFIG_DATABASE_FILENAME = 'config.db';

export type StoragePaths = {
  projectRoot: string;
  dataPath: string;
  chatDbPath: string;
  configDbPath: string;
  statePath: string;
};

export function getStoragePaths(projectRoot = process.cwd()): StoragePaths {
  const canonicalRoot = path.resolve(projectRoot);
  const dataPath = path.join(canonicalRoot, DATA_DIRECTORY_NAME);
  return {
    projectRoot: canonicalRoot,
    dataPath,
    chatDbPath: path.join(dataPath, CHAT_DATABASE_FILENAME),
    configDbPath: path.join(dataPath, CONFIG_DATABASE_FILENAME),
    statePath: path.join(canonicalRoot, STORAGE_STATE_FILENAME),
  };
}

export const STORAGE_PATHS = getStoragePaths();
export const PROJECT_ROOT = STORAGE_PATHS.projectRoot;
export const DATA_PATH = STORAGE_PATHS.dataPath;
export const CHAT_DB_PATH = STORAGE_PATHS.chatDbPath;
export const CONFIG_DB_PATH = STORAGE_PATHS.configDbPath;
export const STORAGE_STATE_PATH = STORAGE_PATHS.statePath;
