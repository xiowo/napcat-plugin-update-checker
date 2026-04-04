import { pluginState } from '../core/state';
import type { PluginInfo, UpdateInfo } from '../types';

const REGISTRY_FILE = 'plugin-update-registry.json';

type UpdateSourceType = 'none' | 'store' | 'git-commit' | 'git-release';

interface PluginUpdateRegistryEntry {
    index: number;
    pluginName: string;
    displayName: string;
    currentVersion: string;
    latestVersion: string;
    storeLatestVersion?: string;
    gitLatestVersion?: string;
    lastSource: UpdateSourceType;
    storeUpdate?: UpdateInfo;
    updatedAt: number;
}

interface PluginUpdateRegistryFile {
    version: number;
    updatedAt: number;
    entries: PluginUpdateRegistryEntry[];
}

const DEFAULT_REGISTRY: PluginUpdateRegistryFile = {
    version: 1,
    updatedAt: 0,
    entries: []
};

function loadRegistry(): PluginUpdateRegistryFile {
    const raw = pluginState.loadDataFile<PluginUpdateRegistryFile>(REGISTRY_FILE, DEFAULT_REGISTRY);
    if (!raw || !Array.isArray(raw.entries)) {
        return { ...DEFAULT_REGISTRY, entries: [] };
    }
    return {
        version: Number(raw.version || 1),
        updatedAt: Number(raw.updatedAt || 0),
        entries: raw.entries
            .filter(item => item && typeof item.pluginName === 'string')
            .map(item => ({
                index: Number(item.index || 0),
                pluginName: String(item.pluginName || ''),
                displayName: String(item.displayName || item.pluginName || ''),
                currentVersion: String(item.currentVersion || '0.0.0'),
                latestVersion: String(item.latestVersion || item.currentVersion || '0.0.0'),
                storeLatestVersion: item.storeLatestVersion ? String(item.storeLatestVersion) : undefined,
                gitLatestVersion: item.gitLatestVersion ? String(item.gitLatestVersion) : undefined,
                lastSource: (item.lastSource || 'none') as UpdateSourceType,
                storeUpdate: item.storeUpdate,
                updatedAt: Number(item.updatedAt || 0)
            }))
    };
}

function saveRegistry(data: PluginUpdateRegistryFile): void {
    pluginState.saveDataFile(REGISTRY_FILE, data);
}

function nextAvailableIndex(used: Set<number>): number {
    let i = 1;
    while (used.has(i)) i++;
    return i;
}

function normalizeStoredUpdate(update?: UpdateInfo): UpdateInfo | undefined {
    if (!update) return undefined;
    return { ...update };
}

function normalizeRepoPath(repoPath: string): string {
    return String(repoPath || '')
        .trim()
        .replace(/\.git$/i, '')
        .replace(/^\/+/, '')
        .toLowerCase();
}

function parseRepoPathFromUrl(rawUrl?: string): string {
    const text = String(rawUrl || '').trim();
    if (!text) return '';

    let normalized = text.replace(/^git\+/i, '');
    const scpMatch = normalized.match(/^git@([^:\/]+):(.+)$/i);
    if (scpMatch) {
        normalized = `https://${scpMatch[1]}/${scpMatch[2]}`;
    }

    try {
        const url = new URL(normalized);
        const parts = (url.pathname || '').split('/').filter(Boolean);
        if (parts.length >= 2) {
            return normalizeRepoPath(`${parts[0]}/${parts[1]}`);
        }
    } catch {
        const m = normalized.match(/^(?:https?:\/\/|ssh:\/\/)?[^/:]+[/:]([^/]+)\/([^/?#]+)(?:[/?#].*)?$/i);
        if (m) {
            return normalizeRepoPath(`${m[1]}/${m[2]}`);
        }
    }

    return '';
}

function extractRepositoryUrl(repository: any): string {
    if (!repository) return '';
    if (typeof repository === 'string') return repository;
    if (typeof repository.url === 'string') return repository.url;
    return '';
}

function getInstalledPluginRepoPathMap(): Map<string, string[]> {
    const result = new Map<string, string[]>();
    try {
        const pm = pluginState.pluginManager;
        if (!pm) return result;
        const all = pm.getAllPlugins() || [];
        for (const p of all) {
            const pluginName = String(p?.packageJson?.name || p?.id || p?.fileId || '').trim();
            if (!pluginName) continue;

            const homepagePath = parseRepoPathFromUrl(p?.packageJson?.homepage || '');
            const repositoryPath = parseRepoPathFromUrl(extractRepositoryUrl(p?.packageJson?.repository));

            const paths = [homepagePath, repositoryPath].filter(Boolean);
            if (paths.length > 0) {
                result.set(pluginName, Array.from(new Set(paths)));
            }
        }
    } catch (e) {
        pluginState.logger.debug('读取已安装插件仓库地址失败:', e);
    }
    return result;
}

/** 仅同步插件编号，不写入更新结果 */
export function syncPluginNumbering(installedPlugins: PluginInfo[]): void {
    const registry = loadRegistry();
    const existingIndexMap = new Map<string, number>();
    const used = new Set<number>();

    for (const entry of registry.entries) {
        if (entry.pluginName && entry.index > 0) {
            existingIndexMap.set(entry.pluginName, entry.index);
            used.add(entry.index);
        }
    }

    const nextEntries: PluginUpdateRegistryEntry[] = installedPlugins.map((plugin) => {
        const pluginName = String(plugin.name || '').trim();
        let idx = existingIndexMap.get(pluginName) || 0;
        if (!idx) {
            idx = nextAvailableIndex(used);
            used.add(idx);
        }

        const old = registry.entries.find(e => e.pluginName === pluginName);
        const current = String(plugin.currentVersion || '0.0.0');
        const storeLatest = old?.storeLatestVersion;
        const gitLatest = old?.gitLatestVersion;
        const latest = storeLatest || gitLatest || current;

        return {
            index: idx,
            pluginName,
            displayName: String(plugin.displayName || pluginName),
            currentVersion: current,
            latestVersion: latest,
            storeLatestVersion: storeLatest,
            gitLatestVersion: gitLatest,
            lastSource: old?.lastSource || 'none',
            storeUpdate: old?.storeUpdate,
            updatedAt: old?.updatedAt || Date.now()
        };
    });

    saveRegistry({
        version: 1,
        updatedAt: Date.now(),
        entries: nextEntries.sort((a, b) => a.index - b.index)
    });
}

/** 用商店检测结果刷新注册表（包含编号与可更新版本） */
export function refreshRegistryWithStoreUpdates(
    installedPlugins: PluginInfo[],
    storeUpdatesByInstalledName: Map<string, UpdateInfo>
): void {
    const registry = loadRegistry();
    const existingIndexMap = new Map<string, number>();
    const used = new Set<number>();

    for (const entry of registry.entries) {
        if (entry.pluginName && entry.index > 0) {
            existingIndexMap.set(entry.pluginName, entry.index);
            used.add(entry.index);
        }
    }

    const nextEntries: PluginUpdateRegistryEntry[] = installedPlugins.map((plugin) => {
        const pluginName = String(plugin.name || '').trim();
        let idx = existingIndexMap.get(pluginName) || 0;
        if (!idx) {
            idx = nextAvailableIndex(used);
            used.add(idx);
        }

        const old = registry.entries.find(e => e.pluginName === pluginName);
        const update = storeUpdatesByInstalledName.get(pluginName);
        const current = String(plugin.currentVersion || '0.0.0');
        const gitLatest = old?.gitLatestVersion;

        const storeLatest = update?.latestVersion;
        const latest = storeLatest || gitLatest || current;
        const lastSource: UpdateSourceType = update ? 'store' : (old?.lastSource || 'none');

        return {
            index: idx,
            pluginName,
            displayName: String(plugin.displayName || pluginName),
            currentVersion: current,
            latestVersion: latest,
            storeLatestVersion: storeLatest,
            gitLatestVersion: gitLatest,
            lastSource,
            storeUpdate: normalizeStoredUpdate(update),
            updatedAt: Date.now()
        };
    });

    saveRegistry({
        version: 1,
        updatedAt: Date.now(),
        entries: nextEntries.sort((a, b) => a.index - b.index)
    });
}

/** 记录 Git 检测到的新版本（按仓库路径匹配已安装插件） */
export function markGitDetectedVersion(repoPath: string, latestVersion: string, source: 'git-commit' | 'git-release'): void {
    const normalizedPath = normalizeRepoPath(repoPath);
    const normalizedVersion = String(latestVersion || '').trim();
    if (!normalizedPath || !normalizedVersion) return;

    const registry = loadRegistry();
    if (!Array.isArray(registry.entries) || registry.entries.length === 0) return;

    const repoPathMap = getInstalledPluginRepoPathMap();
    if (repoPathMap.size === 0) return;

    const hitPluginNames: string[] = [];
    for (const [pluginName, paths] of repoPathMap.entries()) {
        if (paths.some(p => normalizeRepoPath(p) === normalizedPath)) {
            hitPluginNames.push(pluginName);
        }
    }

    if (hitPluginNames.length === 0) return;

    let changed = false;
    for (const entry of registry.entries) {
        if (!hitPluginNames.includes(entry.pluginName)) continue;
        entry.gitLatestVersion = normalizedVersion;
        entry.latestVersion = entry.storeLatestVersion || normalizedVersion || entry.currentVersion;
        entry.lastSource = source;
        entry.updatedAt = Date.now();
        changed = true;
    }

    if (changed) {
        registry.updatedAt = Date.now();
        saveRegistry(registry);
    }
}

/** 获取所有“可直接更新”的商店更新（用于“全部”命令） */
export function getStoreUpdatesFromRegistry(): Array<{ index: number; pluginName: string; displayName: string; update: UpdateInfo }> {
    const registry = loadRegistry();
    return registry.entries
        .filter(entry => !!entry.storeUpdate?.downloadUrl)
        .map(entry => ({
            index: entry.index,
            pluginName: entry.pluginName,
            displayName: entry.displayName,
            update: entry.storeUpdate as UpdateInfo
        }))
        .sort((a, b) => a.index - b.index);
}

/** 按编号获取可更新项 */
export function getStoreUpdateByIndex(index: number): { index: number; pluginName: string; displayName: string; update: UpdateInfo } | null {
    const list = getStoreUpdatesFromRegistry();
    return list.find(item => item.index === index) || null;
}

/** 安装成功后清理对应插件的商店更新记录，避免重复更新 */
export function markStoreUpdateInstalled(pluginName: string, currentVersion?: string): void {
    const target = String(pluginName || '').trim();
    if (!target) return;

    const registry = loadRegistry();
    if (!Array.isArray(registry.entries) || registry.entries.length === 0) return;

    let changed = false;
    for (const entry of registry.entries) {
        if (entry.pluginName !== target) continue;

        entry.storeUpdate = undefined;
        entry.storeLatestVersion = undefined;
        if (currentVersion) {
            entry.currentVersion = String(currentVersion);
        }
        entry.latestVersion = entry.gitLatestVersion || entry.currentVersion;
        entry.lastSource = entry.gitLatestVersion ? 'git-commit' : 'none';
        entry.updatedAt = Date.now();
        changed = true;
    }

    if (changed) {
        registry.updatedAt = Date.now();
        saveRegistry(registry);
    }
}
