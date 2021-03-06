import {
  createWriteStream,
  statSync,
  writeFile as writeFileCallback,
} from 'fs';
import { join, normalize } from 'path';
import { tmpdir } from 'os';

// @ts-ignore
import { createParser } from 'dashdash';
// @ts-ignore
import ProxyAgent from 'proxy-agent';
import { FAILSAFE_SCHEMA, safeLoad } from 'js-yaml';
import { gt } from 'semver';
import { get as getFromConfig } from 'config';
import { get, GotOptions, stream } from 'got';
import { v4 as getGuid } from 'uuid';
import pify from 'pify';
import mkdirp from 'mkdirp';
import rimraf from 'rimraf';
import { app, BrowserWindow, dialog } from 'electron';

import { getTempPath } from '../../app/attachments';

// @ts-ignore
import * as packageJson from '../../package.json';
import { getSignatureFileName } from './signature';

export type MessagesType = {
  [key: string]: {
    message: string;
    description?: string;
  };
};

type LogFunction = (...args: Array<any>) => void;

export type LoggerType = {
  fatal: LogFunction;
  error: LogFunction;
  warn: LogFunction;
  info: LogFunction;
  debug: LogFunction;
  trace: LogFunction;
};

const writeFile = pify(writeFileCallback);
const mkdirpPromise = pify(mkdirp);
const rimrafPromise = pify(rimraf);
const { platform } = process;

export async function checkForUpdates(
  logger: LoggerType
): Promise<{
  fileName: string;
  version: string;
} | null> {
  const yaml = await getUpdateYaml();
  const version = getVersion(yaml);

  if (!version) {
    logger.warn('checkForUpdates: no version extracted from downloaded yaml');

    return null;
  }

  if (isVersionNewer(version)) {
    logger.info(`checkForUpdates: found newer version ${version}`);

    return {
      fileName: getUpdateFileName(yaml),
      version,
    };
  }

  logger.info(
    `checkForUpdates: ${version} is not newer; no new update available`
  );

  return null;
}

export function validatePath(basePath: string, targetPath: string) {
  const normalized = normalize(targetPath);

  if (!normalized.startsWith(basePath)) {
    throw new Error(
      `validatePath: Path ${normalized} is not under base path ${basePath}`
    );
  }
}

export async function downloadUpdate(
  fileName: string,
  logger: LoggerType
): Promise<string> {
  const baseUrl = getUpdatesBase();
  const updateFileUrl = `${baseUrl}/${fileName}`;

  const signatureFileName = getSignatureFileName(fileName);
  const signatureUrl = `${baseUrl}/${signatureFileName}`;

  let tempDir;
  try {
    tempDir = await createTempDir();
    const targetUpdatePath = join(tempDir, fileName);
    const targetSignaturePath = join(tempDir, getSignatureFileName(fileName));

    validatePath(tempDir, targetUpdatePath);
    validatePath(tempDir, targetSignaturePath);

    logger.info(`downloadUpdate: Downloading ${signatureUrl}`);
    const { body } = await get(signatureUrl, getGotOptions());
    await writeFile(targetSignaturePath, body);

    logger.info(`downloadUpdate: Downloading ${updateFileUrl}`);
    const downloadStream = stream(updateFileUrl, getGotOptions());
    const writeStream = createWriteStream(targetUpdatePath);

    await new Promise((resolve, reject) => {
      downloadStream.on('error', error => {
        reject(error);
      });
      downloadStream.on('end', () => {
        resolve();
      });

      writeStream.on('error', error => {
        reject(error);
      });

      downloadStream.pipe(writeStream);
    });

    return targetUpdatePath;
  } catch (error) {
    if (tempDir) {
      await deleteTempDir(tempDir);
    }
    throw error;
  }
}

export async function showUpdateDialog(
  mainWindow: BrowserWindow,
  messages: MessagesType
): Promise<boolean> {
  const RESTART_BUTTON = 0;
  const LATER_BUTTON = 1;
  const options = {
    type: 'info',
    buttons: [
      messages.autoUpdateRestartButtonLabel.message,
      messages.autoUpdateLaterButtonLabel.message,
    ],
    title: messages.autoUpdateNewVersionTitle.message,
    message: messages.autoUpdateNewVersionMessage.message,
    detail: messages.autoUpdateNewVersionInstructions.message,
    defaultId: LATER_BUTTON,
    cancelId: LATER_BUTTON,
  };

  const { response } = await dialog.showMessageBox(mainWindow, options);

  return response === RESTART_BUTTON;
}

export async function showCannotUpdateDialog(
  mainWindow: BrowserWindow,
  messages: MessagesType
): Promise<any> {
  const options = {
    type: 'error',
    buttons: [messages.ok.message],
    title: messages.cannotUpdate.message,
    message: messages.cannotUpdateDetail.message,
  };

  await dialog.showMessageBox(mainWindow, options);
}

// Helper functions

export function getUpdateCheckUrl(): string {
  return `${getUpdatesBase()}/${getUpdatesFileName()}`;
}

export function getUpdatesBase(): string {
  return getFromConfig('updatesUrl');
}
export function getCertificateAuthority(): string {
  return getFromConfig('certificateAuthority');
}
export function getProxyUrl(): string | undefined {
  return process.env.HTTPS_PROXY || process.env.https_proxy;
}

export function getUpdatesFileName(): string {
  const prefix = isBetaChannel() ? 'beta' : 'latest';

  if (platform === 'darwin') {
    return `${prefix}-mac.yml`;
  } else {
    return `${prefix}.yml`;
  }
}

const hasBeta = /beta/i;
function isBetaChannel(): boolean {
  return hasBeta.test(packageJson.version);
}

function isVersionNewer(newVersion: string): boolean {
  const { version } = packageJson;

  return gt(newVersion, version);
}

export function getVersion(yaml: string): string | undefined {
  const info = parseYaml(yaml);

  if (info && info.version) {
    return info.version;
  }

  return;
}

const validFile = /^[A-Za-z0-9\.\-]+$/;
export function isUpdateFileNameValid(name: string) {
  return validFile.test(name);
}

export function getUpdateFileName(yaml: string) {
  const info = parseYaml(yaml);

  if (!info || !info.path) {
    throw new Error('getUpdateFileName: No path present in YAML file');
  }

  const path = info.path;
  if (!isUpdateFileNameValid(path)) {
    throw new Error(
      `getUpdateFileName: Path '${path}' contains invalid characters`
    );
  }

  return path;
}

function parseYaml(yaml: string): any {
  return safeLoad(yaml, { schema: FAILSAFE_SCHEMA, json: true });
}

async function getUpdateYaml(): Promise<string> {
  const targetUrl = getUpdateCheckUrl();
  const { body } = await get(targetUrl, getGotOptions());

  if (!body) {
    throw new Error('Got unexpected response back from update check');
  }

  return body.toString('utf8');
}

function getGotOptions(): GotOptions<null> {
  const ca = getCertificateAuthority();
  const proxyUrl = getProxyUrl();
  const agent = proxyUrl ? new ProxyAgent(proxyUrl) : undefined;

  return {
    agent,
    ca,
    headers: {
      'Cache-Control': 'no-cache',
      'User-Agent': `Signal Desktop ${packageJson.version}`,
    },
    useElectronNet: false,
  };
}

function getBaseTempDir() {
  // We only use tmpdir() when this code is run outside of an Electron app (as in: tests)
  return app ? getTempPath(app.getPath('userData')) : tmpdir();
}

export async function createTempDir() {
  const baseTempDir = getBaseTempDir();
  const uniqueName = getGuid();
  const targetDir = join(baseTempDir, uniqueName);
  await mkdirpPromise(targetDir);

  return targetDir;
}

export async function deleteTempDir(targetDir: string) {
  const pathInfo = statSync(targetDir);
  if (!pathInfo.isDirectory()) {
    throw new Error(
      `deleteTempDir: Cannot delete path '${targetDir}' because it is not a directory`
    );
  }

  const baseTempDir = getBaseTempDir();
  if (!targetDir.startsWith(baseTempDir)) {
    throw new Error(
      `deleteTempDir: Cannot delete path '${targetDir}' since it is not within base temp dir`
    );
  }

  await rimrafPromise(targetDir);
}

export function getPrintableError(error: Error) {
  return error && error.stack ? error.stack : error;
}

export function getCliOptions<T>(options: any): T {
  const parser = createParser({ options });
  const cliOptions = parser.parse(process.argv);

  if (cliOptions.help) {
    const help = parser.help().trimRight();
    // tslint:disable-next-line:no-console
    console.log(help);
    process.exit(0);
  }

  return cliOptions;
}
