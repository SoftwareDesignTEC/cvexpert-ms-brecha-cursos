import { DiscoveryError } from '../course-discovery/model.js';
import { SaylorProvider } from '../course-discovery/saylor-provider.js';
import { saylorFixture, saylorTestSnapshot, saylorTestTime } from '../../test/fixtures/saylor.test.js';
import { memoryDiscoveryStore, planSaylorDiscovery, saylorFixtureConfig } from './saylor.js';

export async function runSaylorDemo(args: string[]) {
    if (new Set(args).size !== args.length || args.some(a => !['--dry-run', '--fixture'].includes(a))) throw new DiscoveryError('INVALID_ARGUMENTS');
    const now = () => Date.parse(saylorTestTime);
    const provider = new SaylorProvider({ mode: 'fixture' }, async () => new Response(JSON.stringify(saylorFixture),
        { headers: { 'content-type': 'application/json' } }), now);
    const report = await planSaylorDiscovery(provider, saylorTestSnapshot(),
        saylorFixtureConfig([{ skill: '[TEST] Contexto de descubrimiento, sin asociación de habilidades', categoryId: 0 }]),
        memoryDiscoveryStore(), 'TEST-saylor-demo', now);
    return { ...report, batch: provider.lastBatch };
}
