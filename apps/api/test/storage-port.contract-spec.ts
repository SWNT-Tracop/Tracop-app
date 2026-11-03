import { InMemoryStorageAdapter } from '../src/modules/catalog/adapters/out/in-memory-storage.adapter.js';
import { randomUUID } from 'node:crypto';
import { storagePortContract } from './support/storage-port-contract.js';

storagePortContract('in memory', async () => {
  const storage = new InMemoryStorageAdapter();
  const keyPrefix = `${randomUUID()}/`;
  return {
    storage,
    keyPrefix,
    upload: (key, bytes) => storage.acceptUpload(key, bytes),
    cleanup: async () => {
      for await (const object of storage.listObjects(keyPrefix))
        await storage.deleteObject(object.key);
    },
  };
});
