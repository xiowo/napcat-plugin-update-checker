/**
 * 更新检测核心逻辑
 * 实现插件更新检测、版本比较、安装等功能
 */

import fs from 'fs';
import path from 'path';
import { createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';
import type { PluginInfo, UpdateInfo, MirrorPingResult, StoreMeta, GitPushConfig, GitProviderName } from '../types';
import { pluginState } from '../core/state';
import { refreshRegistryWithStoreUpdates, syncPluginNumbering } from './update-registry';
import { getRepositoryData } from './git-api';

// 插件商店索引源将从 pluginState.config.pluginSources 动态读取

// GitHub Raw 镜像
export const GITHUB_RAW_MIRRORS = [
    'https://github.chenc.dev/',
    'https://ghproxy.cfd/',
    'https://ghproxy.cc/',
    'https://gh-proxy.net/'
];

// GitHub 文件加速镜像
export const DOWNLOAD_MIRRORS = [
    'https://github.chenc.dev/',
    'https://ghproxy.cfd/',
    'https://github.tbedu.top/',
    'https://ghproxy.cc/',
    'https://gh.monlor.com/',
    'https://cdn.akaere.online/',
    'https://gh.idayer.com/',
    'https://gh.llkk.cc/',
    'https://ghpxy.hwinzniej.top/',
    'https://github-proxy.memory-echoes.cn/',
    'https://git.yylx.win/',
    'https://gitproxy.mrhjx.cn/',
    'https://gh.fhjhy.top/',
    'https://gp.zkitefly.eu.org/',
    'https://gh-proxy.com/',
    'https://ghfile.geekertao.top/',
    'https://j.1lin.dpdns.org/',
    'https://ghproxy.imciel.com/',
    'https://github-proxy.teach-english.tech/',
    'https://gh.927223.xyz/',
    'https://github.ednovas.xyz/',
    'https://ghf.xn--eqrr82bzpe.top/',
    'https://gh.dpik.top/',
    'https://gh.jasonzeng.dev/',
    'https://gh.xxooo.cf/',
    'https://gh.bugdey.us.kg/',
    'https://ghm.078465.xyz/',
    'https://j.1win.ggff.net/',
    'https://tvv.tw/',
    'https://gitproxy.127731.xyz/',
    'https://gh.inkchills.cn/',
    'https://ghproxy.cxkpro.top/',
    'https://gh.sixyin.com/',
    'https://github.geekery.cn/',
    'https://git.669966.xyz/',
    'https://gh.5050net.cn/',
    'https://gh.felicity.ac.cn/',
    'https://github.dpik.top/',
    'https://ghp.keleyaa.com/',
    'https://gh.wsmdn.dpdns.org/',
    'https://ghproxy.monkeyray.net/',
    'https://fastgit.cc/',
    'https://gh.catmak.name/',
    'https://gh.noki.icu/'
];

interface StorePlugin {
    id: string;
    name: string;
    version: string;
    downloadUrl: string;
    downloads?: number;
    description?: string;
    author?: string;
    source?: string;
    changelog?: string;
}

interface StoreStatsItem {
    version?: string;
    updateTime?: string;
    downloadUrl?: string;
    downloads?: number;
    changelog?: string;
}

interface GitReleaseRepoRef {
    id?: string;
    provider: GitProviderName;
    repoPath: string;
}

const AUTO_GIT_PUSH_CONFIG_ID = 'plugin-git-auto-default';

export interface InstallPluginResult {
    ok: boolean;
    message: string;
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

function extractRepositoryUrlFromPackage(repository: any): string {
    if (!repository) return '';
    if (typeof repository === 'string') return repository;
    if (typeof repository.url === 'string') return repository.url;
    return '';
}

function getInstalledPluginRepoPathMap(): Map<string, string> {
    const result = new Map<string, string>();
    const pm = pluginState.pluginManager;
    if (!pm) return result;

    const all = pm.getAllPlugins?.() || [];
    for (const p of all) {
        const pluginName = String(p?.packageJson?.name || p?.id || p?.fileId || '').trim();
        if (!pluginName) continue;

        const repoPath = parseRepoPathFromUrl(extractRepositoryUrlFromPackage(p?.packageJson?.repository))
            || parseRepoPathFromUrl(p?.packageJson?.homepage || '')
            || parseRepoPathFromUrl(p?.homepage || '');

        if (repoPath) {
            result.set(pluginName, repoPath);
        }
    }

    pluginState.logger.info(`[Git检测] 已安装插件可解析仓库数量: ${result.size}`);
    return result;
}

function normalizeGitPushReposForRelease(config: GitPushConfig): Array<{ id: string; provider: GitProviderName; owner: string; repo: string; releaseEnabled: boolean }> {
    if (Array.isArray(config?.repos) && config.repos.length > 0) {
        return config.repos
            .filter(item => item && item.provider && item.owner && item.repo)
            .map(item => ({
                id: String(item.id || `${item.provider}-${item.owner}-${item.repo}`),
                provider: item.provider,
                owner: String(item.owner || '').trim(),
                repo: String(item.repo || '').trim(),
                releaseEnabled: item.releaseEnabled === true,
            }));
    }

    if (config?.provider && config?.owner && config?.repo) {
        return [{
            id: String(config.id || `${config.provider}-${config.owner}-${config.repo}`),
            provider: config.provider,
            owner: String(config.owner || '').trim(),
            repo: String(config.repo || '').trim(),
            releaseEnabled: false,
        }];
    }

    return [];
}

function getGitReleaseRepoMap(): Map<string, GitReleaseRepoRef> {
    const out = new Map<string, GitReleaseRepoRef>();
    const configs = Array.isArray(pluginState.config.gitPushConfigs) ? pluginState.config.gitPushConfigs : [];
    const autoConfig = configs.find(item => String(item?.id || '').trim() === AUTO_GIT_PUSH_CONFIG_ID);
    if (!autoConfig) {
        pluginState.logger.info(`[Git检测] 未找到自动检测配置: ${AUTO_GIT_PUSH_CONFIG_ID}`);
        return out;
    }

    const repos = normalizeGitPushReposForRelease(autoConfig);
    for (const repo of repos) {
        // 自动 Git 检测列表下的仓库默认开启 Release 检测，不再依赖 releaseEnabled 标记
        const repoPath = `${repo.owner}/${repo.repo}`;
        const key = normalizeRepoPath(repoPath);
        if (!key || out.has(key)) continue;

        out.set(key, {
            id: String(repo.id || ''),
            provider: repo.provider,
            repoPath,
        });
    }

    pluginState.logger.info(`[Git检测] 自动检测仓库数量: ${out.size}`);
    return out;
}

function getGitProviderToken(provider: GitProviderName): string {
    const providerText = String(provider || '').trim();
    if (!providerText) return '';

    const list = pluginState.config.gitProviders || [];
    const exact = list.find(item => String(item?.provider || '').trim() === providerText);
    if (exact?.token) return String(exact.token || '');

    const lower = providerText.toLowerCase();
    const hit = list.find(item => String(item?.provider || '').trim().toLowerCase() === lower);
    return String(hit?.token || '');
}

function findGitReleaseRepoForPlugin(
    plugin: PluginInfo,
    gitReleaseRepoMap: Map<string, GitReleaseRepoRef>
): GitReleaseRepoRef | null {
    // 仅按自动列表 repo.id 匹配（不再依赖已安装插件 repository/homepage）
    const rawName = String(plugin.name || '').trim().toLowerCase();
    if (!rawName) return null;
    const slugName = rawName.replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    const exactAutoId = `plugin-auto-${slugName || rawName}`;

    for (const repo of gitReleaseRepoMap.values()) {
        const rid = String(repo.id || '').trim().toLowerCase();
        if (!rid) continue;

        if (rid === exactAutoId || rid === rawName || rid === slugName) {
            pluginState.logger.info(`[Git检测] ${plugin.name} 通过 repo.id 命中自动检测仓库: ${rid} -> ${repo.repoPath}`);
            return repo;
        }
    }

    return null;
}

function isGitReleaseEnabledForPlugin(
    plugin: PluginInfo,
    gitReleaseRepoMap: Map<string, GitReleaseRepoRef>
): boolean {
    return Boolean(findGitReleaseRepoForPlugin(plugin, gitReleaseRepoMap));
}

async function checkGitReleaseUpdateForPlugin(
    plugin: PluginInfo,
    gitReleaseRepoMap: Map<string, GitReleaseRepoRef>
): Promise<UpdateInfo | null> {
    const hit = findGitReleaseRepoForPlugin(plugin, gitReleaseRepoMap);
    if (!hit) {
        pluginState.logger.info(`[Git检测] ${plugin.name} 未命中 repo.id 绑定，跳过 Git 检测`);
        return null;
    }

    const token = getGitProviderToken(hit.provider);
    pluginState.logger.info(`[Git检测] 开始请求 Release: ${plugin.name} -> ${hit.provider} ${hit.repoPath}`);
    const releaseData = await getRepositoryData(hit.repoPath, hit.provider, 'releases', token);
    const release = Array.isArray(releaseData) ? releaseData[0] : releaseData;
    if (!release) {
        pluginState.logger.warn(`[Git检测] Release API 未返回有效数据: ${plugin.name} -> ${hit.provider} ${hit.repoPath}`);
        return null;
    }

    const latestVersion = String(release?.tag_name || release?.name || '').trim();
    if (!latestVersion) {
        pluginState.logger.warn(`[Git检测] Release 缺少版本标识(tag_name/name): ${plugin.name} -> ${hit.provider} ${hit.repoPath}`);
        return null;
    }
    if (!isNewer(plugin.currentVersion, latestVersion)) {
        pluginState.logger.info(`[Git检测] ${plugin.name} 无新版本: ${plugin.currentVersion} -> ${latestVersion}`);
        return null;
    }

    const assets = Array.isArray(release?.assets) ? release.assets : [];
    const zipAsset = assets.find((asset: any) => {
        const browserUrl = String(asset?.browser_download_url || '').trim();
        const directUrl = String(asset?.url || '').trim();
        const name = String(asset?.name || '').trim().toLowerCase();
        const target = browserUrl || directUrl;
        return Boolean(target) && (name.endsWith('.zip') || target.toLowerCase().includes('.zip'));
    });
    const downloadUrl = String(
        zipAsset?.browser_download_url
        || zipAsset?.url
        || release?.zipball_url
        || ''
    ).trim();

    pluginState.logger.info(`[Git检测] ${plugin.name} 发现新版本: ${plugin.currentVersion} -> ${latestVersion}`);
    return {
        pluginName: plugin.name,
        displayName: plugin.displayName,
        currentVersion: plugin.currentVersion,
        latestVersion,
        downloadUrl,
        changelog: '',
        publishedAt: String(release?.published_at || release?.created_at || ''),
        source: `${String(hit.provider || '')}-release`,
    };
}

/** 比较版本号，返回 true 表示 remote > local */
function isNewer(local: string, remote: string): boolean {
    const normalize = (v: string) => v.replace(/^v/i, '');
    const lp = normalize(local).split('.').map(Number);
    const rp = normalize(remote).split('.').map(Number);
    for (let i = 0; i < Math.max(lp.length, rp.length); i++) {
        const l = lp[i] || 0;
        const r = rp[i] || 0;
        if (r > l) return true;
        if (r < l) return false;
    }
    return false;
}

/** 通过 pluginManager 获取已安装插件列表 */
function getInstalledFromManager(): PluginInfo[] {
    const pm = pluginState.pluginManager;
    if (!pm) {
        pluginState.logger.warn('pluginManager 不可用');
        return [];
    }

    const pluginBasePath = pm.getPluginPath?.() || '';
    const all = pm.getAllPlugins();
    const plugins: PluginInfo[] = all
        .filter((p: any) => !!p.id)
        .map((p: any) => {
            // 优先使用 package.json 的 name 作为标识（与商店索引一致）
            const pkgName = p.packageJson?.name;
            const pluginId = pkgName || p.id || p.fileId;
            const folderId = String(p.id || p.fileId || '');

            let storeId = '';
            let storeSource = '';

            // 读取安装时写入的商店元数据，用于“按源限定更新”
            try {
                if (pluginBasePath && folderId) {
                    const storeMetaPath = path.join(pluginBasePath, folderId, '.store-meta.json');
                    if (fs.existsSync(storeMetaPath)) {
                        const meta = JSON.parse(fs.readFileSync(storeMetaPath, 'utf8')) as StoreMeta;
                        storeId = meta.storeId || '';
                        storeSource = meta.source || '';
                    }
                }
            } catch {
            }

            return {
                name: pluginId,
                internalId: String(p.id),
                fileId: folderId,
                storeId: storeId || undefined,
                storeSource: storeSource || undefined,
                displayName: p.packageJson?.plugin || p.name || p.id,
                currentVersion: p.version || '0.0.0',
                status: !p.enable ? 'disabled' : p.loaded ? 'active' : 'stopped',
                homepage: p.packageJson?.homepage || '',
            };
        });

    pluginState.installedPlugins = plugins;
    return plugins;
}

function resolveRelativeUrl(url: string, base: string): string {
    try {
        return new URL(url, base).toString();
    } catch {
        return url;
    }
}

function canUseRawMirrorForUrl(targetUrl: string): boolean {
    try {
        const u = new URL(targetUrl);
        return u.hostname === 'raw.githubusercontent.com';
    } catch {
        return false;
    }
}

function canUseDownloadMirrorForUrl(targetUrl: string): boolean {
    try {
        const u = new URL(targetUrl);
        return u.hostname === 'github.com' || u.hostname === 'www.github.com';
    } catch {
        return false;
    }
}

function buildMirroredUrl(targetUrl: string, mirror: string | undefined, mode: 'raw' | 'download'): string {
    const isDirect = !mirror || mirror === 'direct' || mirror === 'https://raw.githubusercontent.com';
    if (isDirect) return targetUrl;

    const canUseMirror = mode === 'raw'
        ? canUseRawMirrorForUrl(targetUrl)
        : canUseDownloadMirrorForUrl(targetUrl);

    return canUseMirror ? `${mirror}${targetUrl}` : targetUrl;
}

async function fetchJsonByMirrors(
    sourceUrl: string,
    mirrors: string[],
    preferredMirror?: string,
    extraHeaders?: Record<string, string>
): Promise<any | null> {
    const orderedMirrors = preferredMirror
        ? [preferredMirror, ...mirrors.filter(m => m !== preferredMirror)]
        : mirrors;

    const attemptedBaseUrls = new Set<string>();

    for (const mirror of orderedMirrors) {
        try {
            const baseUrl = buildMirroredUrl(sourceUrl, mirror, 'raw');
            if (attemptedBaseUrls.has(baseUrl)) continue;
            attemptedBaseUrls.add(baseUrl);
            const url = `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}t=${Date.now()}`;

            const res = await fetch(url, {
                headers: {
                    'User-Agent': 'NapCat-WebUI',
                    'Cache-Control': 'no-cache',
                    ...(extraHeaders || {}),
                },
                signal: AbortSignal.timeout(10000),
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
            return await res.json();
        } catch (e) {
            pluginState.logger.debug(`拉取 JSON 失败（${mirror || 'direct'}）: ${getErrorMessage(e)}`);
        }
    }

    return null;
}

/** 从商店索引获取数据（按源分别返回，不做跨源合并） */
async function fetchStoreIndexBySource(): Promise<Map<string, Map<string, StorePlugin>>> {
    const selected = pluginState.config.selectedRawMirror;
    const configuredMirrors = pluginState.config.rawMirrors?.length
        ? pluginState.config.rawMirrors
        : GITHUB_RAW_MIRRORS;

    const mirrorsWithDirect = configuredMirrors.includes('direct')
        ? configuredMirrors
        : [...configuredMirrors, 'direct'];

    const mirrors = selected
        ? [selected, ...mirrorsWithDirect.filter(m => m !== selected)]
        : mirrorsWithDirect;

    const configuredSources = pluginState.config.pluginSources || [];
    const enabledSources = configuredSources.filter(s => s.enabled);
    const sources = enabledSources;

    if (enabledSources.length === 0) {
        pluginState.logger.warn('未启用任何插件市场源，已跳过商店索引拉取');
        return new Map<string, Map<string, StorePlugin>>();
    }

    const sourceMap = new Map<string, Map<string, StorePlugin>>();

    for (const sourceObj of sources) {
                const source = sourceObj.url;
                const sourceKey = sourceObj.name || source;
                const sourceRequestHeaders = sourceObj.requestHeaders || {};
                let sourceBest = new Map<string, StorePlugin>();
        let sourceBestLabel = '';

        const attemptedBaseUrls = new Set<string>();

        for (const mirror of mirrors) {
            try {
                const baseUrl = buildMirroredUrl(source, mirror, 'raw');
                if (attemptedBaseUrls.has(baseUrl)) continue;
                attemptedBaseUrls.add(baseUrl);
                const url = `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}t=${Date.now()}`;

                const res = await fetch(url, {
                    headers: {
                        'User-Agent': 'NapCat-WebUI',
                        'Cache-Control': 'no-cache',
                        ...(sourceRequestHeaders || {}),
                    },
                    signal: AbortSignal.timeout(10000),
                });
                if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);

                const data = await res.json() as any;
                const plugins = Array.isArray(data?.plugins) ? data.plugins : [];

                // 版本/下载链接/下载数可从 statsUrl 获取
                const statsRawUrl = typeof data?.statsUrl === 'string' ? data.statsUrl.trim() : '';
                let statsObj: Record<string, StoreStatsItem> = {};
                if (statsRawUrl) {
                    const statsUrl = resolveRelativeUrl(statsRawUrl, source);
                    const statsData = await fetchJsonByMirrors(statsUrl, mirrors, mirror, sourceRequestHeaders);
                    if (statsData && typeof statsData === 'object') {
                        statsObj = statsData as Record<string, StoreStatsItem>;
                    } else {
                        pluginState.logger.debug(`源 ${sourceKey} 的 statsUrl 返回为空或格式不正确: ${statsUrl}`);
                    }
                }

                const map = new Map<string, StorePlugin>();
                for (const p of plugins) {
                    if (!p?.id) continue;

                    const stat = statsObj[p.id] || {};
                    const version = stat.version || p.version;
                    const downloadUrl = stat.downloadUrl || p.downloadUrl;
                    const downloads = Number(stat.downloads);
                    const normalizedDownloads = Number.isFinite(downloads) ? downloads : 0;

                    if (version && downloadUrl) {
                        map.set(p.id, {
                            id: p.id,
                            name: p.name || p.id,
                            version,
                            downloadUrl,
                            downloads: normalizedDownloads,
                            description: p.description,
                            author: p.author,
                            source: sourceKey,
                            changelog: typeof stat.changelog === 'string'
                                ? stat.changelog
                                : (typeof p.changelog === 'string' ? p.changelog : ''),
                        });
                    }
                }

                if (map.size === 0) {
                    continue;
                }

                const label = baseUrl === source ? '直连' : '镜像';
                if (map.size > sourceBest.size) {
                    sourceBest = map;
                    sourceBestLabel = label;
                }

                // 指定镜像/直连成功后优先采用，减少等待
                if (baseUrl === source || mirror === selected) {
                    break;
                }
            } catch (e) {
                pluginState.logger.debug(`源 ${sourceKey} 通过镜像 ${mirror || 'direct'} 拉取失败: ${getErrorMessage(e)}`);
            }
        }

        if (sourceBest.size > 0) {
            pluginState.logger.info(`源 ${sourceKey} 获取成功（${sourceBestLabel || '镜像'}），共 ${sourceBest.size} 个插件`);
            sourceMap.set(sourceKey, sourceBest);
        } else {
            pluginState.logger.warn(`源 ${sourceKey} 获取失败，已跳过`);
        }
    }

    if (sourceMap.size === 0) {
        pluginState.logger.error(`所有商店索引源均不可用（共尝试 ${mirrors.length} 个镜像）`);
        return sourceMap;
    }

    pluginState.logger.info(`商店索引获取完成，共可用 ${sourceMap.size} 个源`);
    return sourceMap;
}

/** 仅用于历史兼容：无来源元数据时，才走跨源合并兜底 */
function buildMergedStoreIndex(sourceIndexMap: Map<string, Map<string, StorePlugin>>): Map<string, StorePlugin> {
    const mergedMap = new Map<string, StorePlugin>();
    for (const sourceMap of sourceIndexMap.values()) {
        for (const [id, item] of sourceMap) {
            const exists = mergedMap.get(id);
            if (!exists || isNewer(exists.version, item.version)) {
                mergedMap.set(id, item);
            }
        }
    }
    return mergedMap;
}

function findStoreInfoForInstalled(
    plugin: PluginInfo,
    storeMap: Map<string, StorePlugin>
): StorePlugin | null {
    const candidates = [
        plugin.storeId,
        plugin.name,
        plugin.fileId,
        plugin.internalId,
    ].filter((v): v is string => Boolean(v));

    for (const id of candidates) {
        const matched = storeMap.get(id);
        if (matched) return matched;
    }

    return null;
}

/** 检查所有插件更新 */
export async function checkAllUpdates(): Promise<UpdateInfo[]> {
    pluginState.logger.info('开始检查插件更新...');

    const installed = getInstalledFromManager();

    // 清理 autoUpdatePlugins 中已不存在的插件
    const installedNames = new Set(installed.map(p => p.name));
    const autoList = pluginState.config.autoUpdatePlugins;
    if (autoList.length > 0) {
        const cleaned = autoList.filter(name => installedNames.has(name));
        if (cleaned.length !== autoList.length) {
            pluginState.config.autoUpdatePlugins = cleaned;
            pluginState.saveConfig();
        }
    }

    const ignored = new Set(pluginState.config.ignoredPlugins);
    const disableStoreCheck = new Set(pluginState.config.disableStoreCheckPlugins || []);
    const updates: UpdateInfo[] = [];
    const actionableUpdatesByInstalledName = new Map<string, UpdateInfo>();
    const installedRepoPathMap = getInstalledPluginRepoPathMap();
    const gitReleaseRepoMap = getGitReleaseRepoMap();

    pluginState.logger.info(`[Git检测] 当前已安装插件总数: ${installed.length}`);

    const needsStoreCheck = installed.some(plugin => {
        if (ignored.has(plugin.name)) return false;
        if (disableStoreCheck.has(plugin.name)) return false;
        const gitEnabled = isGitReleaseEnabledForPlugin(plugin, gitReleaseRepoMap);
        return !gitEnabled;
    });
    pluginState.logger.info(`[Git检测] 是否需要商店检测: ${needsStoreCheck ? '是' : '否'}`);

    let sourceStoreMap = new Map<string, Map<string, StorePlugin>>();
    let mergedStoreMap = new Map<string, StorePlugin>();

    if (needsStoreCheck) {
        sourceStoreMap = await fetchStoreIndexBySource();
        mergedStoreMap = buildMergedStoreIndex(sourceStoreMap);

        if (sourceStoreMap.size === 0) {
            pluginState.logger.warn('商店索引为空，本次仅执行 Git 检测');
        }
    }

    for (const plugin of installed) {
        if (ignored.has(plugin.name)) {
            pluginState.logger.info(`[Git检测] ${plugin.name} 在 ignoredPlugins 中，跳过`);
            continue;
        }

        const gitEnabled = isGitReleaseEnabledForPlugin(plugin, gitReleaseRepoMap);

        // Git 检测与商店检测分离：只有开启“使用 Git 检测更新”才走 Git
        if (gitEnabled) {
            pluginState.logger.info(`[Git检测] ${plugin.name} 命中自动检测仓库，执行 Git Release 检测`);
            const gitUpdate = await checkGitReleaseUpdateForPlugin(plugin, gitReleaseRepoMap);
            if (gitUpdate) {
                updates.push(gitUpdate);
                if (gitUpdate.downloadUrl) {
                    actionableUpdatesByInstalledName.set(plugin.name, gitUpdate);
                }
            }
            continue;
        }

        const parsedRepo = installedRepoPathMap.get(plugin.name) || '';
        pluginState.logger.info(`[Git检测] ${plugin.name} 未命中自动检测仓库（repo=${parsedRepo || '未解析'}）`);

        // 禁用商店源检测且未开启 Git 检测时，跳过
        if (disableStoreCheck.has(plugin.name)) {
            pluginState.logger.info(`[Git检测] ${plugin.name} 在 disableStoreCheckPlugins 中，且未开启 Git，跳过`);
            continue;
        }

        // 有商店元数据时：只按对应源检查，不跨源比版本
        const targetStoreMap = plugin.storeSource
            ? sourceStoreMap.get(plugin.storeSource)
            : mergedStoreMap;

        if (!targetStoreMap) continue;

        const storeInfo = findStoreInfoForInstalled(plugin, targetStoreMap);
        if (!storeInfo) continue;

        if (isNewer(plugin.currentVersion, storeInfo.version)) {
            const updateItem: UpdateInfo = {
                pluginName: storeInfo.id,
                displayName: plugin.displayName,
                currentVersion: plugin.currentVersion,
                latestVersion: storeInfo.version,
                downloadUrl: storeInfo.downloadUrl,
                changelog: storeInfo.changelog || '',
                publishedAt: '',
                source: storeInfo.source,
            };
            updates.push(updateItem);
            actionableUpdatesByInstalledName.set(plugin.name, updateItem);
        }
    }

    refreshRegistryWithStoreUpdates(installed, actionableUpdatesByInstalledName);

    pluginState.availableUpdates = updates;
    pluginState.lastCheckTime = Date.now();

    if (updates.length > 0) {
        pluginState.logger.info(`发现 ${updates.length} 个可更新: ${updates.map(u => `${u.displayName} ${u.currentVersion} → ${u.latestVersion}`).join(', ')}`);
    } else {
        pluginState.logger.info('所有插件均为最新版本');
    }
    return updates;
}

/** 根据插件包名（商店 id）查找 NapCat 内部 id */
function resolveInternalId(pluginName: string): string {
    const found = pluginState.installedPlugins.find(p => p.name === pluginName);
    return found?.internalId || pluginName;
}

/** 检查单个插件更新 */
export async function checkSinglePlugin(pluginName: string): Promise<UpdateInfo | null> {
    pluginState.logger.info(`检查单个插件更新: ${pluginName}`);

    const pm = pluginState.pluginManager;
    if (!pm) { pluginState.logger.warn('pluginManager 不可用'); return null; }

    // 先刷新一次安装列表，拿到最新的 storeId/storeSource 元数据
    getInstalledFromManager();
    const installed = pluginState.installedPlugins.find(p => p.name === pluginName);

    const internalId = resolveInternalId(pluginName);
    const entry = pm.getPluginInfo(internalId);
    if (!entry) { pluginState.logger.warn(`未找到插件: ${pluginName} (内部id: ${internalId})`); return null; }

    const currentVersion = entry.version || '0.0.0';
    const ignored = new Set(pluginState.config.ignoredPlugins);
    const disableStoreCheck = new Set(pluginState.config.disableStoreCheckPlugins || []);
    if (ignored.has(pluginName)) {
        pluginState.logger.info(`${pluginName} 在黑名单中，已跳过更新检测`);
        return null;
    }

    const installedRepoPathMap = getInstalledPluginRepoPathMap();
    const gitReleaseRepoMap = getGitReleaseRepoMap();

    const pluginForGit: PluginInfo = installed || {
        name: pluginName,
        internalId,
        displayName: entry.packageJson?.plugin || entry.name || pluginName,
        currentVersion,
        status: !entry.enable ? 'disabled' : entry.loaded ? 'active' : 'stopped',
        homepage: entry.packageJson?.homepage || '',
    };

    const gitEnabled = isGitReleaseEnabledForPlugin(pluginForGit, gitReleaseRepoMap);

    // Git 检测与商店检测分离：开启 Git 检测时仅走 Git
    if (gitEnabled) {
        const gitUpdate = await checkGitReleaseUpdateForPlugin(pluginForGit, gitReleaseRepoMap);
        if (gitUpdate) {
            pluginState.availableUpdates = pluginState.availableUpdates.filter(
                u => u.pluginName !== pluginName && u.pluginName !== gitUpdate.pluginName
            );
            pluginState.availableUpdates.push(gitUpdate);

            const installedList = getInstalledFromManager();
            const actionableMap = new Map<string, UpdateInfo>();
            if (gitUpdate.downloadUrl) {
                actionableMap.set(pluginName, gitUpdate);
                refreshRegistryWithStoreUpdates(installedList, actionableMap);
            } else {
                syncPluginNumbering(installedList);
            }

            pluginState.logger.info(`${pluginName}: ${currentVersion} → ${gitUpdate.latestVersion} (Git Release, auto-config)`);
            return gitUpdate;
        }

        syncPluginNumbering(getInstalledFromManager());
        pluginState.logger.info(`${pluginName} 已开启 Git 检测，但 Release 未发现更新`);
        return null;
    }

    if (disableStoreCheck.has(pluginName)) {
        syncPluginNumbering(getInstalledFromManager());
        pluginState.logger.info(`${pluginName} 已禁用商店源检测，且未开启 Git 检测`);
        return null;
    }

    const sourceStoreMap = await fetchStoreIndexBySource();
    const mergedStoreMap = buildMergedStoreIndex(sourceStoreMap);

    // 有商店元数据时：只按对应源检查，不跨源比版本
    const targetStoreMap = installed?.storeSource
        ? sourceStoreMap.get(installed.storeSource)
        : mergedStoreMap;

    if (!targetStoreMap) {
        pluginState.logger.info(`${pluginName} 已记录来源 ${installed?.storeSource || ''}，但该源当前不可用`);
        return null;
    }

    // 兼容 storeId 缺失场景：按 storeId/name/fileId/internalId 多候选匹配
    const storeInfo = installed
        ? findStoreInfoForInstalled(installed, targetStoreMap) || targetStoreMap.get(pluginName)
        : targetStoreMap.get(pluginName);

    if (!storeInfo) { pluginState.logger.info(`${pluginName} 不在商店中`); return null; }

    // 更新 installedPlugins 中的版本
    if (installed) installed.currentVersion = currentVersion;

    pluginState.availableUpdates = pluginState.availableUpdates.filter(
        u => u.pluginName !== pluginName && u.pluginName !== storeInfo.id
    );

    if (isNewer(currentVersion, storeInfo.version)) {
        const update: UpdateInfo = {
            pluginName: storeInfo.id,
            displayName: entry.packageJson?.plugin || entry.name || pluginName,
            currentVersion,
            latestVersion: storeInfo.version,
            downloadUrl: storeInfo.downloadUrl,
            changelog: storeInfo.changelog || '',
            publishedAt: '',
            source: storeInfo.source,
        };
        pluginState.availableUpdates.push(update);

        const installedList = getInstalledFromManager();
        const map = new Map<string, UpdateInfo>();
        map.set(pluginName, update);
        refreshRegistryWithStoreUpdates(installedList, map);

        pluginState.logger.info(`${pluginName}: ${currentVersion} → ${storeInfo.version} 有更新`);
        return update;
    }

    syncPluginNumbering(getInstalledFromManager());

    pluginState.logger.info(`${pluginName} 已是最新 (${currentVersion})`);
    return null;
}

/** 下载文件 */
async function downloadWithMirror(url: string, destPath: string, extraHeaders?: Record<string, string>): Promise<void> {
    const selected = pluginState.config.selectedDownloadMirror;
    const downloadMirrorsConfig = pluginState.config.downloadMirrors?.length
        ? pluginState.config.downloadMirrors
        : DOWNLOAD_MIRRORS;

    const mirrorsWithDirect = downloadMirrorsConfig.includes('direct')
        ? downloadMirrorsConfig
        : [...downloadMirrorsConfig, 'direct'];

    const mirrors = selected
        ? [selected, ...mirrorsWithDirect.filter(m => m !== selected)]
        : mirrorsWithDirect;

    const attemptedUrls = new Set<string>();

    for (const mirror of mirrors) {
        try {
            const finalUrl = buildMirroredUrl(url, mirror, 'download');
            if (attemptedUrls.has(finalUrl)) continue;
            attemptedUrls.add(finalUrl);

            const res = await fetch(finalUrl, {
                headers: {
                    'User-Agent': 'napcat-plugin-update-checker',
                    ...(extraHeaders || {}),
                },
                signal: AbortSignal.timeout(120000),
                redirect: 'follow',
            });
            if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
            const fileStream = createWriteStream(destPath);
            await pipeline(Readable.fromWeb(res.body as any), fileStream);
            return;
        } catch (e) {
            pluginState.logger.debug(`下载失败，镜像 ${mirror || 'direct'}: ${getErrorMessage(e)}`);
        }
    }
    throw new Error('所有下载镜像均失败');
}

function copyDirSync(src: string, dest: string): void {
    if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        const s = path.join(src, entry.name);
        const d = path.join(dest, entry.name);
        if (entry.isDirectory()) copyDirSync(s, d);
        else fs.copyFileSync(s, d);
    }
}

function getErrorMessage(err: unknown): string {
    if (err instanceof Error) return err.message;
    return String(err);
}

function validatePluginId(pluginId: string): string {
    const safeId = path.basename(String(pluginId || ''));
    if (!safeId || !/^[a-zA-Z0-9._-]+$/.test(safeId)) {
        throw new Error('非法插件 ID');
    }
    return safeId;
}

function getPluginDataDir(pluginId: string): string {
    const safeId = validatePluginId(pluginId);
    const pm = pluginState.pluginManager as any;

    if (pm?.getPluginDataPath) {
        return pm.getPluginDataPath(safeId);
    }

    const pluginConfigDir = path.dirname(pluginState.ctx.configPath);
    const pluginsConfigRoot = path.dirname(pluginConfigDir);
    return path.join(pluginsConfigRoot, safeId);
}

export function getCachedPluginIconPath(pluginId: string): string {
    return path.join(getPluginDataDir(pluginId), 'icon.png');
}

export function hasCachedPluginIcon(pluginId: string): boolean {
    try {
        return fs.existsSync(getCachedPluginIconPath(pluginId));
    } catch {
        return false;
    }
}

function extractRepositoryUrl(repository: any): string {
    if (!repository) return '';
    if (typeof repository === 'string') return repository;
    if (typeof repository.url === 'string') return repository.url;
    return '';
}

function extractGithubOwner(rawUrl: string): string {
    if (!rawUrl) return '';

    const tryParseOwner = (urlStr: string): string => {
        try {
            const u = new URL(urlStr);
            if (u.hostname !== 'github.com' && u.hostname !== 'www.github.com') {
                return '';
            }
            const parts = u.pathname.split('/').filter(Boolean);
            return parts[0] || '';
        } catch {
            return '';
        }
    };

    // 直接解析
    let owner = tryParseOwner(rawUrl);
    if (owner) return owner;

    const marker = 'https://github.com/';
    const idx = rawUrl.indexOf(marker);
    if (idx >= 0) {
        owner = tryParseOwner(rawUrl.slice(idx));
        if (owner) return owner;
    }

    return '';
}

async function cachePluginIcon(pluginId: string, candidates: Array<string | undefined>): Promise<void> {
    const iconPath = getCachedPluginIconPath(pluginId);
    if (fs.existsSync(iconPath)) {
        return;
    }

    const owners = new Set<string>();
    for (const candidate of candidates) {
        const owner = extractGithubOwner(String(candidate || '').trim());
        if (owner) owners.add(owner);
    }

    if (owners.size === 0) return;

    const dataDir = path.dirname(iconPath);
    if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
    }

    for (const owner of owners) {
        const avatarUrl = `https://github.com/${owner}.png`;
        try {
            const res = await fetch(avatarUrl, {
                headers: { 'User-Agent': 'napcat-plugin-update-checker' },
                signal: AbortSignal.timeout(15000),
                redirect: 'follow',
            });
            if (!res.ok || !res.body) continue;

            const fileStream = createWriteStream(iconPath);
            await pipeline(Readable.fromWeb(res.body as any), fileStream);
            pluginState.logger.info(`已缓存插件图标: ${pluginId}`);
            return;
        } catch (e) {
            pluginState.logger.debug(`缓存图标失败（${owner}）: ${getErrorMessage(e)}`);
        }
    }
}

/** 安装/更新单个插件 */
export async function installPluginWithResult(update: UpdateInfo): Promise<InstallPluginResult> {
    const pm = pluginState.pluginManager;
    if (!pm) {
        const message = 'pluginManager 不可用';
        pluginState.logger.error(message);
        return { ok: false, message };
    }

    let operationText: '安装' | '更新' = update.currentVersion === '0.0.0' ? '安装' : '更新';
    pluginState.logger.info(`正在${operationText} ${update.displayName} ${operationText === '安装' ? '' : '到 v' + update.latestVersion}...`);

    const pluginsDir = pm.getPluginPath();
    const tmpZip = path.join(pluginsDir, `temp_${Date.now()}.zip`);
    const tmpExtract = path.join(pluginsDir, `temp_extract_${Date.now()}`);

    const originalMirror = pluginState.config.selectedDownloadMirror;
    const usedCustomMirror = Boolean(update.mirror);

    try {
        // 如果提供了镜像，暂时覆盖配置中的镜像
        if (usedCustomMirror) {
            pluginState.config.selectedDownloadMirror = update.mirror || '';
            pluginState.logger.info(`使用指定镜像下载: ${update.mirror}`);
        }

        const sourceDownloadHeaders = (() => {
            const sourceName = String(update.source || '').trim();
            if (!sourceName) return undefined;
            const matched = (pluginState.config.pluginSources || []).find(s => String(s.name || '').trim() === sourceName);
            return matched?.downloadHeaders;
        })();

        // 下载
        await downloadWithMirror(update.downloadUrl, tmpZip, sourceDownloadHeaders);

        // 解压到临时目录
        if (fs.existsSync(tmpExtract)) fs.rmSync(tmpExtract, { recursive: true, force: true });
        fs.mkdirSync(tmpExtract, { recursive: true });

        const isWin = process.platform === 'win32';
        if (isWin) {
            const { execSync } = await import('child_process');
            execSync(`powershell -Command "Expand-Archive -Path '${tmpZip}' -DestinationPath '${tmpExtract}' -Force"`, { timeout: 30000 });
        } else {
            const { execSync } = await import('child_process');
            execSync(`unzip -o "${tmpZip}" -d "${tmpExtract}"`, { timeout: 30000 });
        }

        // 找到实际内容目录
        let sourceDir = tmpExtract;
        const entries = fs.readdirSync(tmpExtract);
        if (entries.length === 1) {
            const single = path.join(tmpExtract, entries[0]);
            if (fs.statSync(single).isDirectory()) sourceDir = single;
        }

        // 检查是否包含 package.json
        const packageJsonPath = path.join(sourceDir, 'package.json');
        if (!fs.existsSync(packageJsonPath)) {
            throw new Error('插件格式错误：缺少 package.json 文件');
        }

        // 读取 package.json 获取插件名称
        const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
        const pluginName = packageJson.name;
        if (!pluginName) {
            throw new Error('插件格式错误：package.json 中缺少 name 字段');
        }

        const homepage = typeof packageJson.homepage === 'string' ? packageJson.homepage : '';
        const repositoryUrl = extractRepositoryUrl(packageJson.repository);

        // 检查是否已安装同名插件
        const pluginDir = path.join(pluginsDir, pluginName);
        const pluginExists = fs.existsSync(pluginDir);
        if (pluginExists && operationText === '安装') {
            operationText = '更新';
            pluginState.logger.info(`插件 ${pluginName} 已存在，自动切换为更新流程`);
        } else if (!pluginExists && operationText === '更新') {
            operationText = '安装';
            pluginState.logger.info(`插件 ${pluginName} 不存在，自动切换为安装流程`);
        }

        // 备份用户配置
        let configBackup: string | null = null;
        if (pluginExists) {
            configBackup = path.join(pluginsDir, `${pluginName}.config.bak`);
            const userConfigPath = path.join(pluginDir, 'data', 'config.json');
            if (fs.existsSync(userConfigPath)) {
                fs.copyFileSync(userConfigPath, configBackup);
            }
        }

        // 复制到目标目录
        if (fs.existsSync(pluginDir)) {
            fs.rmSync(pluginDir, { recursive: true, force: true });
        }
        fs.mkdirSync(pluginDir, { recursive: true });

        // 复制文件
        copyDirSync(sourceDir, pluginDir);

        // 写入商店元数据，方便后续匹配商店 ID 与已安装插件
        const storeMeta: StoreMeta = {
            storeId: update.pluginName,        // 商店索引中的 ID
            displayName: update.displayName,   // 商店中的显示名称
            installedAt: new Date().toISOString(),
            source: update.source,             // 商店源名称
        };
        fs.writeFileSync(path.join(pluginDir, '.store-meta.json'), JSON.stringify(storeMeta, null, 2), 'utf8');

        // 恢复用户配置
        if (configBackup && fs.existsSync(configBackup)) {
            const userConfigPath = path.join(pluginDir, 'data', 'config.json');
            const dataDir = path.join(pluginDir, 'data');
            if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
            fs.copyFileSync(configBackup, userConfigPath);
            fs.unlinkSync(configBackup);
        }

        // 缓存插件图标
        try {
            await cachePluginIcon(pluginName, [update.downloadUrl, homepage, repositoryUrl]);
        } catch (e) {
            pluginState.logger.debug(`缓存插件图标异常: ${getErrorMessage(e)}`);
        }

        // 通过 pluginManager 重载或加载插件
        const existingPlugins = pm.getAllPlugins();
        const existingPlugin = existingPlugins.find((p: any) => p.id === pluginName || p.packageJson?.name === pluginName);

        if (existingPlugin) {
            pluginState.logger.info(`重载插件: ${pluginName}`);
            await pm.reloadPlugin(existingPlugin.id);
        } else {
            pluginState.logger.info(`加载新插件: ${pluginName}`);
            // 尝试加载插件
            try {
                await pm.loadPluginById(pluginName);
            } catch (e) {
                pluginState.logger.warn(`加载插件失败: ${e}`);
            }
        }

        // 更新成功后，从 availableUpdates 中移除该插件
        pluginState.availableUpdates = pluginState.availableUpdates.filter(u => u.pluginName !== update.pluginName);

        // 重新获取已安装插件列表
        getInstalledFromManager();

        const successMessage = `插件 ${update.displayName} ${operationText}成功`;
        pluginState.logger.info(`✅ ${successMessage}`);
        return { ok: true, message: successMessage };
    } catch (e) {
        const errorMessage = getErrorMessage(e);
        pluginState.logger.error(`${operationText} ${update.displayName} 失败: ${errorMessage}`);
        return { ok: false, message: errorMessage };
    } finally {
        // 恢复原始镜像配置
        if (usedCustomMirror) {
            pluginState.config.selectedDownloadMirror = originalMirror;
        }

        // 清理临时文件
        if (fs.existsSync(tmpZip)) fs.unlinkSync(tmpZip);
        if (fs.existsSync(tmpExtract)) fs.rmSync(tmpExtract, { recursive: true, force: true });
    }
}

/** 安装/更新单个插件 */
export async function installPlugin(update: UpdateInfo): Promise<boolean> {
    const result = await installPluginWithResult(update);
    return result.ok;
}

/** 获取已安装插件列表（供 API 使用） */
export async function getInstalledPlugins(): Promise<PluginInfo[]> {
    const installed = getInstalledFromManager();
    syncPluginNumbering(installed);
    return installed;
}

/** 给镜像打标签 */
function mirrorLabel(url: string): string {
    if (!url || url === 'direct' || url === 'https://raw.githubusercontent.com') return '直连 (raw.githubusercontent.com)';
    try {
        return new URL(url).hostname;
    } catch { return url; }
}

function downloadMirrorLabel(url: string): string {
    if (!url || url === 'direct') return '直连 (github.com)';
    try {
        return new URL(url).hostname;
    } catch { return url; }
}

/** Ping 所有 Raw 镜像，返回延迟结果 */
export async function pingRawMirrors(): Promise<MirrorPingResult[]> {
    const mirrorsToTest = pluginState.config.rawMirrors || GITHUB_RAW_MIRRORS;
    const enabledSources = pluginState.config.pluginSources?.filter(s => s.enabled) || [];
    if (enabledSources.length === 0) {
        pluginState.logger.warn('未启用任何插件市场源，已跳过 Raw 镜像测速');
        return [];
    }

    const source = enabledSources[0].url;
    const results = await Promise.all(mirrorsToTest.map(async (mirror) => {
        const url = (mirror && mirror !== 'direct' && mirror !== 'https://raw.githubusercontent.com') ? `${mirror}${source}` : source;
        const start = Date.now();
        try {
            const res = await fetch(url, {
                method: 'HEAD',
                headers: { 'User-Agent': 'napcat-plugin-update-checker' },
                signal: AbortSignal.timeout(8000),
            });
            const latency = Date.now() - start;
            return { url: mirror, label: mirrorLabel(mirror), latency, ok: res.ok };
        } catch {
            return { url: mirror, label: mirrorLabel(mirror), latency: -1, ok: false };
        }
    }));
    return results.sort((a, b) => {
        if (a.ok && !b.ok) return -1;
        if (!a.ok && b.ok) return 1;
        return a.latency - b.latency;
    });
}

/** Ping 所有 下载 镜像，返回延迟结果 */
export async function pingDownloadMirrors(): Promise<MirrorPingResult[]> {
    const testUrl = 'https://github.com/NapNeko/NapCatQQ/releases/latest';
    const mirrorsToTest = pluginState.config.downloadMirrors || DOWNLOAD_MIRRORS;
    const results = await Promise.all(mirrorsToTest.map(async (mirror) => {
        const url = (mirror && mirror !== 'direct') ? `${mirror}${testUrl}` : testUrl;
        const start = Date.now();
        try {
            const res = await fetch(url, {
                method: 'HEAD',
                headers: { 'User-Agent': 'napcat-plugin-update-checker' },
                signal: AbortSignal.timeout(8000),
                redirect: 'follow',
            });
            const latency = Date.now() - start;
            return { url: mirror, label: downloadMirrorLabel(mirror), latency, ok: res.status >= 200 && res.status < 400 };
        } catch {
            return { url: mirror, label: downloadMirrorLabel(mirror), latency: -1, ok: false };
        }
    }));
    return results.sort((a, b) => {
        if (a.ok && !b.ok) return -1;
        if (!a.ok && b.ok) return 1;
        return a.latency - b.latency;
    });
}
