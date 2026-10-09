/** Numeric MCP activity only. This is not the model's context/token usage. */
export class ContextProgress {
    private readonly owners = new Map<string, { calls: number; bytes: number }>();
    observe(owner: string, bytes: number): boolean {
        const progress = this.owners.get(owner) ?? { calls: 0, bytes: 0 };
        const due = progress.calls + 1 >= 20 || progress.bytes + bytes >= 64 * 1024;
        this.owners.delete(owner);
        this.owners.set(owner, due ? { calls: 0, bytes: 0 } : { calls: progress.calls + 1, bytes: progress.bytes + bytes });
        // Bound memory, including abandoned conversations. Never retain tool bodies.
        if (this.owners.size > 1_000) this.owners.delete(this.owners.keys().next().value!);
        return due;
    }
    reset(owner: string): void { this.owners.delete(owner); }
}
