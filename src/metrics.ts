/**
 * Prometheus metrics — dependency-free text exposition.
 * Modelled on NodeLink's stats manager (counters + gauges, `/metrics`).
 */

export class Metrics {
	private counters = new Map<string, number>();
	private gauges = new Map<string, number>();

	inc(name: string, by = 1): void {
		this.counters.set(name, (this.counters.get(name) ?? 0) + by);
	}

	setGauge(name: string, value: number): void {
		this.gauges.set(name, value);
	}

	/** Render Prometheus text format. */
	render(): string {
		const lines: string[] = [];
		for (const [name, value] of this.counters) {
			lines.push(`# TYPE ${name} counter`);
			lines.push(`${name} ${value}`);
		}
		for (const [name, value] of this.gauges) {
			lines.push(`# TYPE ${name} gauge`);
			lines.push(`${name} ${value}`);
		}
		if (lines.length === 0) lines.push("# no metrics yet");
		return `${lines.join("\n")}\n`;
	}
}
