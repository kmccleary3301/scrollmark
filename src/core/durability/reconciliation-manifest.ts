import { canonicalize, type Checkpoint, type ReconciliationItem } from './contracts';
import { IncrementalSha256 } from './incremental-sha256';

export class StateBootstrapManifestHasher {
  private readonly hash = new IncrementalSha256();
  private itemCount = 0;
  private finalized = false;

  constructor(
    private readonly namespaceId: string,
    private readonly sourceCheckpoint: Checkpoint,
    private readonly targetCheckpoint: Checkpoint,
  ) {
    this.hash.update('{"items":[');
  }

  add(items: readonly ReconciliationItem[]): void {
    if (this.finalized) throw new Error('state bootstrap manifest is already finalized');
    for (const item of items) {
      if (this.itemCount) this.hash.update(',');
      this.hash.update(canonicalize(item));
      this.itemCount += 1;
    }
  }

  digestHex(): string {
    if (this.finalized) throw new Error('state bootstrap manifest is already finalized');
    this.finalized = true;
    this.hash.update(`],"mode":"state_bootstrap","namespace_id":${canonicalize(this.namespaceId)}`);
    this.hash.update(`,"source_checkpoint":${canonicalize(this.sourceCheckpoint)}`);
    this.hash.update(`,"target_checkpoint":${canonicalize(this.targetCheckpoint)}}`);
    return this.hash.digestHex();
  }

  get count(): number {
    return this.itemCount;
  }
}
