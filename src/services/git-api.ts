/**
 * Git API 适配器
 * 支持 GitHub/Gitee/Gitcode/Gitea/CNB
 */

import type { GitProviderName, GitProviderConfig } from '../types';
import { pluginState } from '../core/state';

const DEFAULT_API_BASE: Record<GitProviderName, string> = {
    GitHub: 'https://api.github.com/repos',
    Gitee: 'https://gitee.com/api/v5/repos',
    Gitcode: 'https://api.gitcode.com/api/v5/repos',
    Gitea: 'https://gitea.com/api/v1/repos',
    CNB: 'https://api.cnb.cool'
};

function normalizeProvider(provider: string): GitProviderName {
    const mapping: Record<string, GitProviderName> = {
        github: 'GitHub',
        gitee: 'Gitee',
        gitcode: 'Gitcode',
        gitea: 'Gitea',
        cnb: 'CNB'
    };
    return mapping[String(provider || '').toLowerCase()] || 'GitHub';
}

function getApiBase(provider: GitProviderName, configs: GitProviderConfig[] = []): string {
    const cfg = configs.find(item => normalizeProvider(item.provider) === provider);
    return cfg?.apiBase || DEFAULT_API_BASE[provider];
}


function isGitea(provider: GitProviderName): boolean {
    return provider.toLowerCase().includes('gitea');
}

function isGitee(provider: GitProviderName): boolean {
    return provider.toLowerCase().includes('gitee');
}

function isGitcode(provider: GitProviderName): boolean {
    return provider.toLowerCase().includes('gitcode');
}

function isCNB(provider: GitProviderName): boolean {
    return provider.toLowerCase().includes('cnb');
}

function buildHeaders(provider: GitProviderName, token?: string): Record<string, string> {
    const headers: Record<string, string> = {
        'User-Agent': 'napcat-plugin-update-checker',
        Accept: (() => {
            switch (provider) {
                case 'GitHub':
                    return 'application/vnd.github+json';
                case 'Gitee':
                    return 'application/vnd.gitee+json';
                default:
                    return 'application/json';
            }
        })()
    };

    if (!token) return headers;

    switch (provider) {
        case 'GitHub':
        case 'CNB':
            headers.Authorization = `Bearer ${token}`;
            break;
        case 'Gitcode':
            headers['PRIVATE-TOKEN'] = token;
            break;
        case 'Gitee':
        case 'Gitea':
            headers.Authorization = `token ${token}`;
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
    branch?: string;
}

function buildDebugLine(meta: GitRequestDebugMeta, elapsed: number): string {
    return `[Git检测] ${meta.repo} 分支=${meta.branch || '-'} 用时=${elapsed}ms`;
}

async function fetchJson(url: string, headers: Record<string, string>, meta: GitRequestDebugMeta): Promise<any> {
    const startedAt = Date.now();
    try {
        const res = await fetch(url, { headers });
        const elapsed = Date.now() - startedAt;

        if (!res.ok) {
            pluginState.logger.warn(`Git API 请求失败: ${buildDebugLine(meta, elapsed)}`);
            pluginState.logger.debug(buildDebugLine(meta, elapsed));
            return null;
        }

        const contentType = res.headers.get('content-type') || '';
        if (!contentType.includes('application/json')) {
            pluginState.logger.warn(`Git API 响应非 JSON: ${buildDebugLine(meta, elapsed)}`);
            pluginState.logger.debug(buildDebugLine(meta, elapsed));
            return null;
        }

        const data = await res.json();
        pluginState.logger.debug(buildDebugLine(meta, elapsed));
        return data;
    } catch (e) {
        const elapsed = Date.now() - startedAt;
        pluginState.logger.warn(`Git API 请求异常: ${buildDebugLine(meta, elapsed)}`, e);
        pluginState.logger.debug(buildDebugLine(meta, elapsed));
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
    const apiBase = getApiBase(provider, pluginState.config.gitProviders || []);
    const headers = buildHeaders(provider, token);
    const params = new URLSearchParams();

    let pathname = '';
    if (type === 'commits' && branchOrSha) {
        if (isGitea(provider)) {
            pathname = `${repo}/commits`;
            params.set('page', '1');
            params.set('sha', branchOrSha);
        } else if (isCNB(provider)) {
            pathname = `${repo}/-/git/commits/${branchOrSha}`;
        } else {
            pathname = `${repo}/commits/${branchOrSha}`;
            if (isGitcode(provider)) params.set('show_diff', 'true');
        }
    } else {
        if (isCNB(provider)) {
            pathname = `${repo}/-/git/${type}`;
            params.set('page', '1');
        } else {
            pathname = `${repo}/${type}`;
            if (isGitea(provider)) {
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
        branch: branchOrSha || (type === 'releases' ? 'release' : '')
    });
}

export async function getDefaultBranch(
    repo: string,
    provider: GitProviderName,
    token?: string
): Promise<string | null> {
    const apiBase = getApiBase(provider, pluginState.config.gitProviders || []);
    const headers = buildHeaders(provider, token);

    const url = isCNB(provider)
        ? joinUrl(apiBase, `${repo}/-/git/head`)
        : joinUrl(apiBase, `${repo}`);

    const data = await fetchJson(url, headers, {
        repo,
        branch: 'default'
    });
    if (!data) return null;

    if (isCNB(provider)) {
        return data?.name || null;
    }

    return data?.default_branch || null;
}
