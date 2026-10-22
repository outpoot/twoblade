const buckets = new Map<string, { count: number; resetAt: number }>();

export function hitRateLimit(key: string, limit: number, windowMs: number): boolean {
	const now = Date.now();

	if (buckets.size > 10000) {
		for (const [k, v] of buckets) {
			if (v.resetAt <= now) buckets.delete(k);
		}
	}

	const entry = buckets.get(key);
	if (!entry || entry.resetAt <= now) {
		buckets.set(key, { count: 1, resetAt: now + windowMs });
		return false;
	}

	entry.count++;
	return entry.count > limit;
}
