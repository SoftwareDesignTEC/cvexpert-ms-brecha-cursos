import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { createApp } from '../../src/app.js';

export async function withHttpApp<T>(app: ReturnType<typeof createApp>, work: (url: string) => Promise<T>): Promise<T> {
    const server = app.listen(0, '127.0.0.1');
    try {
        if (!server.listening) await once(server, 'listening');
        return await work(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    } finally {
        try {
            await new Promise<void>((resolve, reject) => {
                server.close(error => error ? reject(error) : resolve());
            });
        } finally {
            await app.closeResources();
        }
    }
}
