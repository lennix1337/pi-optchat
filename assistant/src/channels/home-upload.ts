export class HomeUpload {
  private cache?: { source: string; file: string };
  private retryAt = 0;
  constructor(private readonly render: (source: string) => Promise<Buffer>, private readonly fetcher: typeof fetch,
    private readonly call: (method: string, data: Record<string, unknown>, form?: boolean) => Promise<Record<string, unknown>>,
    private readonly fileHost: RegExp) {}

  async diagram(source: string): Promise<{ file?: string; source?: string }> {
    try {
      let file = this.cache?.source === source ? this.cache.file : undefined;
      if (!file) {
        if (Date.now() < this.retryAt) throw new Error('diagram_retry_later');
        const png = await this.render(source);
        const slot = await this.call('files.getUploadURLExternal', { filename: 'optchat-home.png', length: png.length }, true);
        if (typeof slot.upload_url !== 'string' || !this.fileHost.test(slot.upload_url) || typeof slot.file_id !== 'string' || !/^F[A-Z0-9]+$/.test(slot.file_id)) throw new Error('invalid_upload_slot');
        const response = await this.fetcher(slot.upload_url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(60_000), body: new Uint8Array(png) });
        if (!response.ok) throw new Error('diagram_upload_failed');
        await this.call('files.completeUploadExternal', { files: [{ id: slot.file_id, title: 'OptChat Home' }] });
        file = slot.file_id;
        this.cache = { source, file };
        this.retryAt = 0;
      }
      return { file };
    } catch {
      if (Date.now() >= this.retryAt) this.retryAt = Date.now() + 60_000;
      return { source };
    }
  }
}
