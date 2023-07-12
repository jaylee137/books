import fs from 'fs-extra';
import { DatabaseError } from 'fyo/utils/errors';
import path from 'path';
import { DatabaseDemuxBase, DatabaseMethod } from 'utils/db/types';
import { getSchemas } from '../../schemas';
import { checkFileAccess, databaseMethodSet, unlinkIfExists } from '../helpers';
import patches from '../patches';
import { BespokeQueries } from './bespoke';
import DatabaseCore from './core';
import { runPatches } from './runPatch';
import { BespokeFunction, Patch } from './types';
import BetterSQLite3 from 'better-sqlite3';
import { getMapFromList } from 'utils/index';
import { Version } from 'utils/version';

export class DatabaseManager extends DatabaseDemuxBase {
  db?: DatabaseCore;

  get #isInitialized(): boolean {
    return this.db !== undefined && this.db.knex !== undefined;
  }

  getSchemaMap() {
    if (this.#isInitialized) {
      return this.db?.schemaMap ?? getSchemas();
    }

    return getSchemas();
  }

  async createNewDatabase(dbPath: string, countryCode: string) {
    await unlinkIfExists(dbPath);
    return await this.connectToDatabase(dbPath, countryCode);
  }

  async connectToDatabase(dbPath: string, countryCode?: string) {
    countryCode = await this._connect(dbPath, countryCode);
    await this.#migrate();
    return countryCode;
  }

  async _connect(dbPath: string, countryCode?: string) {
    countryCode ??= await DatabaseCore.getCountryCode(dbPath);
    this.db = new DatabaseCore(dbPath);
    await this.db.connect();
    const schemaMap = getSchemas(countryCode);
    this.db.setSchemaMap(schemaMap);
    return countryCode;
  }

  async #migrate(): Promise<void> {
    if (!this.#isInitialized) {
      return;
    }

    const isFirstRun = this.#getIsFirstRun();
    if (isFirstRun) {
      await this.db!.migrate();
    }

    await this.#executeMigration();
  }

  async #handleFailedMigration(
    error: unknown,
    dbPath: string,
    copyPath: string | null
  ) {
    await this.db!.close();

    if (copyPath && (await checkFileAccess(copyPath))) {
      await fs.copyFile(copyPath, dbPath);
    }

    if (error instanceof Error) {
      error.message = `failed migration\n${error.message}`;
    }

    throw error;
  }

  async #executeMigration() {
    const version = this.#getAppVersion();
    const patches = await this.#getPatchesToExecute(version);

    const hasPatches = !!patches.pre.length || !!patches.post.length;
    if (hasPatches) {
      await this.#createBackup();
    }

    await runPatches(patches.pre, this, version);
    await this.db!.migrate({
      pre: async () => {
        if (hasPatches) {
          return;
        }

        await this.#createBackup();
      },
    });
    await runPatches(patches.post, this, version);
  }

  async #getPatchesToExecute(
    version: string
  ): Promise<{ pre: Patch[]; post: Patch[] }> {
    if (this.db === undefined) {
      return { pre: [], post: [] };
    }

    const query = (await this.db.knex!('PatchRun').select()) as {
      name: string;
      version?: string;
      failed?: boolean;
    }[];

    const runPatchesMap = getMapFromList(query, 'name');
    /**
     * A patch is run only if:
     * - it hasn't run and was added in a future version
     *    i.e. app version is before patch added version
     * - it ran but failed in some other version (i.e fixed)
     */
    const filtered = patches
      .filter((p) => {
        const exec = runPatchesMap[p.name];
        if (!exec && Version.lte(version, p.version)) {
          return true;
        }

        if (exec?.failed && exec?.version !== version) {
          return true;
        }

        return false;
      })
      .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));

    return {
      pre: filtered.filter((p) => p.patch.beforeMigrate),
      post: filtered.filter((p) => !p.patch.beforeMigrate),
    };
  }

  async call(method: DatabaseMethod, ...args: unknown[]) {
    if (!this.#isInitialized) {
      return;
    }

    if (!databaseMethodSet.has(method)) {
      return;
    }

    // @ts-ignore
    const response = await this.db[method](...args);
    if (method === 'close') {
      delete this.db;
    }

    return response;
  }

  async callBespoke(method: string, ...args: unknown[]): Promise<unknown> {
    if (!this.#isInitialized) {
      return;
    }

    if (!BespokeQueries.hasOwnProperty(method)) {
      throw new DatabaseError(`invalid bespoke db function ${method}`);
    }

    const queryFunction: BespokeFunction =
      BespokeQueries[method as keyof BespokeFunction];
    return await queryFunction(this.db!, ...args);
  }

  #getIsFirstRun(): boolean {
    const db = this.getDriver();
    if (!db) {
      return true;
    }

    const noPatchRun =
      db
        .prepare(
          `select name from sqlite_master
           where
            type = 'table' and
            name = 'PatchRun'`
        )
        .all().length === 0;

    db.close();
    return noPatchRun;
  }

  async #createBackup() {
    const { dbPath } = this.db ?? {};
    if (!dbPath) {
      return;
    }

    const backupPath = this.#getBackupFilePath();
    if (!backupPath) {
      return;
    }

    const db = this.getDriver();
    await db?.backup(backupPath);
    db?.close();
  }

  #getBackupFilePath() {
    const { dbPath } = this.db ?? {};
    if (dbPath === ':memory:' || !dbPath) {
      return null;
    }

    let fileName = path.parse(dbPath).name;
    if (fileName.endsWith('.books')) {
      fileName = fileName.slice(0, -6);
    }

    const backupFolder = path.join(path.dirname(dbPath), 'backups');
    const date = new Date().toISOString().split('.')[0];
    const version = this.#getAppVersion();
    const backupFile = `${fileName}-${version}-${date}.books.db`;
    fs.ensureDirSync(backupFolder);
    return path.join(backupFolder, backupFile);
  }

  #getAppVersion() {
    const db = this.getDriver();
    if (!db) {
      return '0.0.0';
    }

    const query = db
      .prepare(
        `select value from SingleValue
         where
          fieldname = 'version' and
          parent = 'SystemSettings'`
      )
      .get() as undefined | { value: string };
    db.close();
    return query?.value || '0.0.0';
  }

  getDriver() {
    const { dbPath } = this.db ?? {};
    if (!dbPath) {
      return null;
    }

    return BetterSQLite3(dbPath, { readonly: true });
  }
}

export default new DatabaseManager();
