
import { lstat, mkdir, readFile, unlink } from 'node:fs/promises'
import path from 'node:path'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { LocalCredentialProvider, parseCredentialsDocument, renderFlatLayoutMigration } from '@deepseek-ai/dsh-credentials-local'
import { createCredentialStore, credentialScope, desktopCredentialHelper } from './credential-store.js'

export default class WindowsCredentials extends LocalCredentialProvider {
  constructor(ctx, config) {
    super(ctx, { ...config, watch: false })
    const helper = desktopCredentialHelper()
    if (!helper) throw new Error('The Windows credential service requires the desktop DPAPI helper.')
    this.store = createCredentialStore(helper, credentialScope('dsh', this.spec.filename))
  }

  async locked(operation) {
    const file = this.spec.filename
    await mkdir(path.dirname(file), { recursive: true })
    return withFileLock(file, operation)
  }

  async reloadProtected() {
    const { document } = await this.store.read()
    const { refs, records } = document ? parseCredentialsDocument(document, this.spec.filename)
      : { refs: new Map(), records: new Map() }
    this.values = refs
    this.records = records
  }

  async saveProtected(refs, records) {
    const document = JSON.stringify({ version: 1, refs: Object.fromEntries(refs), records: Object.fromEntries(records) })
    const validated = parseCredentialsDocument(document, this.spec.filename)
    await this.store.write(refs.size || records.size ? { document } : {})
    this.values = validated.refs
    this.records = validated.records
  }

  async loadInitial() {
    // The inherited service lifecycle invokes this method and skips the
    // plaintext watcher because its construction forces watch=false.
    await this.locked(async () => {
      await this.reloadProtected()
      const file = this.spec.filename
      try {
        if (!(await lstat(file)).isFile()) throw new Error('The old DSH credentials path must be a regular file.')
        const plain = await readFile(file, 'utf8')
        const legacy = parseCredentialsDocument(renderFlatLayoutMigration(plain) ?? plain, file)
        await this.saveProtected(new Map([...legacy.refs, ...this.values]), new Map([...legacy.records, ...this.records]))
        await unlink(file)
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
    })
  }

  async transaction(operation) {
    if (this.isClosed()) throw new Error('The DSH credential service has stopped.')
    return this.enqueue(() => this.locked(async () => {
      await this.reloadProtected()
      return operation()
    }))
  }

  write(ref, value) {
    return this.transaction(async () => {
      const next = new Map(this.values)
      if (value === undefined && !next.delete(ref)) return
      if (value !== undefined) next.set(ref, value)
      await this.saveProtected(next, this.records)
      this.notifyUpdated(ref)
    })
  }

  modifyRecord(key, mutate) {
    return this.transaction(async () => {
      const current = this.records.get(key)
      const value = await mutate(current)
      if (value === undefined) return current
      const next = new Map(this.records).set(key, value)
      await this.saveProtected(this.values, next)
      this.notifyRecordUpdated(key)
      return this.records.get(key)
    })
  }

  deleteRecord(key) {
    return this.transaction(async () => {
      const next = new Map(this.records)
      if (!next.delete(key)) return
      await this.saveProtected(this.values, next)
      this.notifyRecordUpdated(key)
    })
  }
}
