import {
  QueueDriverInterface,
  QueueDriverConnectionInterface,
  QueryStageStateResponse,
  QueryDef,
  RetrieveForProcessingResponse,
  QueueDriverOptions,
  AddToQueueQuery,
  AddToQueueOptions, AddToQueueResponse, QueryKey,
} from '@cubejs-backend/base-driver';

import crypto from 'crypto';
import { CubeStoreDriver } from './CubeStoreDriver';

function hashQueryKey(queryKey: QueryKey) {
  return crypto.createHash('md5').update(JSON.stringify(queryKey)).digest('hex');
}

class CubestoreQueueDriverConnection implements QueueDriverConnectionInterface {
  public constructor(
    protected readonly driver: CubeStoreDriver,
    protected readonly options: QueueDriverOptions,
  ) { }

  public redisHash(queryKey: QueryKey): string {
    return hashQueryKey(queryKey);
  }

  protected prefixKey(queryKey: QueryKey): string {
    return `${this.options.redisQueuePrefix}:${queryKey}`;
  }

  public async addToQueue(
    keyScore: number,
    queryKey: QueryKey,
    orphanedTime: any,
    queryHandler: string,
    query: AddToQueueQuery,
    priority: number,
    options: AddToQueueOptions
  ): Promise<AddToQueueResponse> {
    // TODO: Fix sqlparser, support negative number
    priority = priority < 0 ? 0 : priority;

    const data = {
      queryHandler,
      query,
      queryKey,
      stageQueryKey: options.stageQueryKey,
      priority,
      requestId: options.requestId,
      addedToQueueTime: new Date().getTime()
    };

    const rows = await this.driver.query('QUEUE ADD PRIORITY ? ? ?', [
      priority,
      this.prefixKey(this.redisHash(queryKey)),
      JSON.stringify(data)
    ]);
    if (rows && rows.length) {
      return [
        rows[0].added === 'true' ? 1 : 0,
        null,
        null,
        parseInt(rows[0].pending, 10),
        data.addedToQueueTime
      ];
    }

    throw new Error('Empty response on QUEUE ADD');
  }

  // TODO: Looks useless, because we can do it in one step - getQueriesToCancel
  public async getQueryAndRemove(queryKey: string): Promise<[QueryDef]> {
    return [await this.cancelQuery(queryKey)];
  }

  public async cancelQuery(queryKey: string): Promise<QueryDef | null> {
    const rows = await this.driver.query('QUEUE CANCEL ?', [
      this.prefixKey(queryKey)
    ]);
    if (rows && rows.length) {
      return this.decodeQueryDefFromRow(rows[0]);
    }

    return null;
  }

  public async freeProcessingLock(_queryKey: string, _processingId: string, _activated: unknown): Promise<void> {
    // nothing to do
  }

  public async getActiveQueries(): Promise<string[]> {
    const rows = await this.driver.query('QUEUE ACTIVE ?', [
      this.options.redisQueuePrefix
    ]);
    return rows.map((row) => row.id);
  }

  public async getToProcessQueries(): Promise<string[]> {
    const rows = await this.driver.query('QUEUE PENDING ?', [
      this.options.redisQueuePrefix
    ]);
    return rows.map((row) => row.id);
  }

  public async getActiveAndToProcess(): Promise<[active: string[], toProcess: string[]]> {
    const rows = await this.driver.query('QUEUE LIST ?', [
      this.options.redisQueuePrefix
    ]);
    if (rows.length) {
      const active: string[] = [];
      const toProcess: string[] = [];

      for (const row of rows) {
        if (row.status === 'active') {
          active.push(row.id);
        } else {
          toProcess.push(row.id);
        }
      }

      return [
        active,
        toProcess,
      ];
    }

    return [[], []];
  }

  public async getNextProcessingId(): Promise<number | string> {
    const rows = await this.driver.query('CACHE INCR ?', [
      `${this.options.redisQueuePrefix}:PROCESSING_COUNTER`
    ]);
    if (rows && rows.length) {
      return rows[0].value;
    }

    throw new Error('Unable to get next processing id');
  }

  public async getQueryStageState(onlyKeys: boolean): Promise<QueryStageStateResponse> {
    const rows = await this.driver.query(`QUEUE LIST ${onlyKeys ? '?' : 'WITH_PAYLOAD ?'}`, [
      this.options.redisQueuePrefix
    ]);

    const defs: Record<string, QueryDef> = {};
    const toProcess: string[] = [];
    const active: string[] = [];

    for (const row of rows) {
      if (!onlyKeys) {
        defs[row.id] = this.decodeQueryDefFromRow(row);
      }

      if (row.status === 'pending') {
        toProcess.push(row.id);
      } else if (row.status === 'active') {
        active.push(row.id);
        // TODO: getQueryStage is broken for Executing query stage...
        toProcess.push(row.id);
      }
    }

    return [active, toProcess, defs];
  }

  public async getResult(queryKey: string): Promise<unknown> {
    const rows = await this.driver.query('QUEUE RESULT ?', [
      this.prefixKey(this.redisHash(queryKey)),
    ]);
    if (rows && rows.length) {
      return JSON.parse(rows[0].value);
    }

    return null;
  }

  public async getStalledQueries(): Promise<string[]> {
    const rows = await this.driver.query('QUEUE STALLED ? ?', [
      this.options.heartBeatTimeout * 1000,
      this.options.redisQueuePrefix
    ]);
    return rows.map((row) => row.id);
  }

  public async getOrphanedQueries(): Promise<string[]> {
    const rows = await this.driver.query('QUEUE ORPHANED ? ?', [
      this.options.orphanedTimeout * 1000,
      this.options.redisQueuePrefix
    ]);
    return rows.map((row) => row.id);
  }

  public async getQueriesToCancel(): Promise<string[]> {
    const rows = await this.driver.query('QUEUE TO_CANCEL ? ? ?', [
      this.options.heartBeatTimeout * 1000,
      this.options.orphanedTimeout * 1000,
      this.options.redisQueuePrefix,
    ]);
    return rows.map((row) => row.id);
  }

  protected decodeQueryDefFromRow(row: any): QueryDef {
    const payload = JSON.parse(row.payload);

    if (row.extra) {
      return Object.assign(payload, JSON.parse(row.extra));
    }

    return payload;
  }

  public async getQueryDef(queryKey: string): Promise<QueryDef | null> {
    const rows = await this.driver.query('QUEUE GET ?', [
      this.prefixKey(this.redisHash(queryKey))
    ]);
    if (rows && rows.length) {
      return this.decodeQueryDefFromRow(rows[0]);
    }

    return null;
  }

  public async optimisticQueryUpdate(queryKey: any, toUpdate: any, _processingId: any): Promise<boolean> {
    await this.driver.query('QUEUE MERGE_EXTRA ? ?', [
      this.prefixKey(queryKey),
      JSON.stringify(toUpdate)
    ]);

    return true;
  }

  public release(): void {
    // nothing to release
  }

  public async retrieveForProcessing(queryKey: string, _processingId: string): Promise<RetrieveForProcessingResponse> {
    const rows = await this.driver.query('QUEUE RETRIEVE CONCURRENCY ? ?', [
      this.options.concurrency,
      this.prefixKey(queryKey),
    ]);
    if (rows && rows.length) {
      const addedCount = 1;
      const active = [this.redisHash(queryKey)];
      const toProcess = 0;
      const lockAcquired = true;
      const def = this.decodeQueryDefFromRow(rows[0]);

      return [
        addedCount, null, active, toProcess, def, lockAcquired
      ];
    }

    return null;
  }

  public async getResultBlocking(queryKey: string): Promise<QueryDef | null> {
    const rows = await this.driver.query('QUEUE RESULT_BLOCKING ? ?', [
      this.options.continueWaitTimeout * 1000,
      this.prefixKey(this.redisHash(queryKey)),
    ]);
    if (rows && rows.length) {
      return this.decodeQueryDefFromRow(rows[0]);
    }

    return null;
  }

  public async setResultAndRemoveQuery(queryKey: string, executionResult: any, _processingId: any): Promise<boolean> {
    await this.driver.query('QUEUE ACK ? ? ', [
      this.prefixKey(queryKey),
      JSON.stringify(executionResult)
    ]);

    return true;
  }

  public async updateHeartBeat(queryKey: string): Promise<void> {
    await this.driver.query('QUEUE HEARTBEAT ?', [
      this.prefixKey(queryKey)
    ]);
  }
}

export class CubeStoreQueueDriver implements QueueDriverInterface {
  public constructor(
    protected readonly driverFactory: () => Promise<CubeStoreDriver>,
    protected readonly options: QueueDriverOptions
  ) {}

  protected connection: CubeStoreDriver | null = null;

  public redisHash(queryKey: QueryKey) {
    return hashQueryKey(queryKey);
  }

  protected async getConnection(): Promise<CubeStoreDriver> {
    if (this.connection) {
      return this.connection;
    }

    // eslint-disable-next-line no-return-assign
    return this.connection = await this.driverFactory();
  }

  public async createConnection(): Promise<CubestoreQueueDriverConnection> {
    return new CubestoreQueueDriverConnection(await this.getConnection(), this.options);
  }

  public release(): void {
    // nothing to release
  }
}