import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let shotium: Promise<typeof import('@pixel.js/shotium')> | undefined;
const pendingRenders = new Set<Promise<string>>();
let stopping = false;

function loadShotium(): Promise<typeof import('@pixel.js/shotium')> {
    shotium ??= import('@pixel.js/shotium').catch((error) => {
        shotium = undefined;
        throw error;
    });
    return shotium;
}

export function initRenderer(): void {
    stopping = false;
}

async function captureHtml(html: string): Promise<string> {
    const { screenshot } = await loadShotium();
    const directory = await mkdtemp(join(tmpdir(), 'update-checker-render-'));
    try {
        const file = join(directory, 'index.html');
        await writeFile(file, html, 'utf8');
        const { image } = await screenshot({
            file,
            type: 'png',
            selector: '.container',
            viewport: { width: 760, height: 800 },
            scale: 2,
            allowFileAccess: false,
            pageGotoParams: { timeout: 30_000, waitUntil: 'load' },
        });
        if (!image?.length) {
            throw new Error('Shotium 未返回图片数据');
        }
        return image.toString('base64');
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

export async function renderHtml(html: string): Promise<string> {
    if (stopping) throw new Error('渲染服务已停止');
    const render = captureHtml(html);
    pendingRenders.add(render);
    try {
        return await render;
    } finally {
        pendingRenders.delete(render);
    }
}

export async function cleanupRenderer(): Promise<void> {
    stopping = true;
    await Promise.allSettled(pendingRenders);
    if (shotium) {
        await (await shotium).stop();
    }
}
