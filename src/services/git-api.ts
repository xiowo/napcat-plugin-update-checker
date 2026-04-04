/**
 * Git API 适配器
 * 支持 GitHub/Gitee/Gitcode/Gitea/CNB
 */

import type { GitProviderName, GitProviderConfig, GitApiFormat } from '../types';
import { pluginState } from '../core/state';

const DEFAULT_API_BASE: Record<string, string> = {
    github: 'https://api.github.com/repos',
    gitee: 'https://gitee.com/api/v5/repos',
    gitcode: 'https://api.gitcode.com/api/v5/repos',
    gitea: 'https://gitea.com/api/v1/repos',
    cnb: 'https://api.cnb.cool'
};

type ProviderKind = 'github' | 'gitee' | 'gitcode' | 'gitea' | 'cnb' | 'custom';

interface ProviderRuntime {
    kind: ProviderKind;
    apiFormat: GitApiFormat;
    config?: GitProviderConfig;
}

function normalizeProviderKey(provider: string): ProviderKind {
    const key = String(provider || '').trim().toLowerCase();
    if (key === 'github') return 'github';
    if (key === 'gitee') return 'gitee';
    if (key === 'gitcode') return 'gitcode';
    if (key === 'gitea') return 'gitea';
    if (key === 'cnb') return 'cnb';
    return 'custom';
}

function getProviderConfig(provider: GitProviderName, configs: GitProviderConfig[] = []): GitProviderConfig | undefined {
    const providerText = String(provider || '').trim();
    if (!providerText) return undefined;

    const exact = configs.find(item => String(item?.provider || '').trim() === providerText);
    if (exact) return exact;

    const lower = providerText.toLowerCase();
    return configs.find(item => String(item?.provider || '').trim().toLowerCase() === lower);
}

function resolveProviderRuntime(provider: GitProviderName, configs: GitProviderConfig[] = []): ProviderRuntime {
    const providerKey = normalizeProviderKey(provider);
    const cfg = getProviderConfig(provider, configs);

    if (providerKey === 'gitea') {
        return { kind: 'gitea', apiFormat: 'gitea', config: cfg };
    }

    if (providerKey === 'github' || providerKey === 'gitee' || providerKey === 'gitcode' || providerKey === 'cnb') {
        return { kind: providerKey, apiFormat: 'github', config: cfg };
    }

    return {
        kind: 'custom',
        apiFormat: cfg?.apiFormat === 'gitea' ? 'gitea' : 'github',
        config: cfg
    };
}

function getApiBase(provider: GitProviderName, runtime: ProviderRuntime): string {
    const customBase = String(runtime?.config?.apiBase || '').trim();
    if (customBase) return customBase;

    if (runtime.kind === 'custom') {
        return runtime.apiFormat === 'gitea'
            ? DEFAULT_API_BASE.gitea
            : DEFAULT_API_BASE.github;
    }

    return DEFAULT_API_BASE[runtime.kind] || DEFAULT_API_BASE.github;
}

function isGitea(runtime: ProviderRuntime): boolean {
    return runtime.kind === 'gitea' || (runtime.kind === 'custom' && runtime.apiFormat === 'gitea');
}

function isGitee(runtime: ProviderRuntime): boolean {
    return runtime.kind === 'gitee';
}

function isGitcode(runtime: ProviderRuntime): boolean {
    return runtime.kind === 'gitcode';
}

function isCNB(runtime: ProviderRuntime): boolean {
    return runtime.kind === 'cnb';
}

function buildHeaders(runtime: ProviderRuntime, token?: string): Record<string, string> {
    const headers: Record<string, string> = {
        'User-Agent': 'napcat-plugin-update-checker',
        Accept: (() => {
            switch (runtime.kind) {
                case 'github':
                    return 'application/vnd.github+json';
                case 'gitee':
                    return 'application/vnd.gitee+json';
                default:
                    return 'application/json';
            }
        })()
    };

    if (!token) return headers;

    switch (runtime.kind) {
        case 'github':
        case 'cnb':
            headers.Authorization = `Bearer ${token}`;
            break;
        case 'gitcode':
            headers['PRIVATE-TOKEN'] = token;
            break;
        case 'gitee':
        case 'gitea':
            headers.Authorization = `token ${token}`;
            break;
        case 'custom':
            headers.Authorization = runtime.apiFormat === 'gitea'
                ? `token ${token}`
                : `Bearer ${token}`;
            break;
        default:
            headers.Authorization = `Bearer ${token}`;
            break;
    }

    return headers;
}

function joinUrl(base: string, relative: string): string {
    try {
        const u = new URL(base);
        const basePath = (u.pathname || '').replace(/\/+$/, '');
        const rel = String(relative).replace(/^\/+/, '');
        u.pathname = basePath === '' ? `/${rel}` : `${basePath}/${rel}`;
        return u.toString();
    } catch {
        const b = String(base).replace(/\/+$/, '');
        const r = String(relative).replace(/^\/+/, '');
        return `${b}/${r}`;
    }
}

interface GitRequestDebugMeta {
    repo: string;
    provider: GitProviderName;
    requestType: 'commits' | 'releases' | 'default-branch';
    branch?: string;
}

function buildGitLogLine(meta: GitRequestDebugMeta, elapsed: number, status?: number): string {
    const branchText = meta.branch || '-';
    const statusText = typeof status === 'number' ? ` 状态=${status}` : '';
    return `[Git请求] [${meta.provider}] ${meta.repo} 类型=${meta.requestType} 分支=${branchText}${statusText} 用时=${elapsed}ms`;
}

const GIT_API_TIMEOUT_MS = 15000;

async function fetchJson(url: string, headers: Record<string, string>, meta: GitRequestDebugMeta): Promise<any> {
    const startedAt = Date.now();
    try {
        const res = await fetch(url, {
            headers,
            signal: AbortSignal.timeout(GIT_API_TIMEOUT_MS),
        });
        const elapsed = Date.now() - startedAt;

        if (!res.ok) {
            pluginState.logger.warn(`Git API 请求失败: ${buildGitLogLine(meta, elapsed, res.status)}`);
            return null;
        }

        const contentType = res.headers.get('content-type') || '';
        if (!contentType.includes('application/json')) {
            pluginState.logger.warn(`Git API 响应非 JSON: ${buildGitLogLine(meta, elapsed, res.status)}`);
            return null;
        }

        const data = await res.json();
        pluginState.logger.info(`Git API 请求成功: ${buildGitLogLine(meta, elapsed, res.status)}`);
        return data;
    } catch (e) {
        const elapsed = Date.now() - startedAt;
        const errMsg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
        pluginState.logger.warn(`Git API 请求异常: ${buildGitLogLine(meta, elapsed)} 错误=${errMsg}`, e);
        return null;
    }
}

export async function getRepositoryData(
    repo: string,
    provider: GitProviderName,
    type: 'commits' | 'releases',
    token?: string,
    branchOrSha?: string
): Promise<any> {
    const providerRuntime = resolveProviderRuntime(provider, pluginState.config.gitProviders || []);
    const apiBase = getApiBase(provider, providerRuntime);
    const headers = buildHeaders(providerRuntime, token);
    const params = new URLSearchParams();

    let pathname = '';
    if (type === 'commits' && branchOrSha) {
        if (isGitea(providerRuntime)) {
            pathname = `${repo}/commits`;
            params.set('page', '1');
            params.set('sha', branchOrSha);
        } else if (isCNB(providerRuntime)) {
            pathname = `${repo}/-/git/commits/${branchOrSha}`;
        } else {
            pathname = `${repo}/commits/${branchOrSha}`;
            if (isGitcode(providerRuntime)) params.set('show_diff', 'true');
        }
    } else {
        if (isCNB(providerRuntime)) {
            pathname = `${repo}/-/git/${type}`;
            params.set('page', '1');
        } else {
            pathname = `${repo}/${type}`;
            if (isGitea(providerRuntime)) {
                params.set('page', '1');
            } else if (type === 'commits') {
                params.set('per_page', '1');
            }
        }
    }

    const url = new URL(joinUrl(apiBase, pathname));
    for (const [key, value] of params.entries()) {
        url.searchParams.set(key, value);
    }

    return await fetchJson(url.toString(), headers, {
        repo,
        provider,
        requestType: type,
        branch: branchOrSha || (type === 'releases' ? 'release' : '')
    });
}

export async function getDefaultBranch(
    repo: string,
    provider: GitProviderName,
    token?: string
): Promise<string | null> {
    const providerRuntime = resolveProviderRuntime(provider, pluginState.config.gitProviders || []);
    const apiBase = getApiBase(provider, providerRuntime);
    const headers = buildHeaders(providerRuntime, token);

    const url = isCNB(providerRuntime)
        ? joinUrl(apiBase, `${repo}/-/git/head`)
        : joinUrl(apiBase, `${repo}`);

    const data = await fetchJson(url, headers, {
        repo,
        provider,
        requestType: 'default-branch',
        branch: 'default'
    });
    if (!data) return null;

    if (isCNB(providerRuntime)) {
        return data?.name || null;
    }

    return data?.default_branch || null;
}
