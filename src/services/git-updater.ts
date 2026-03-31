/**
 * Git 仓库更新检测与推送
 */

import { pluginState } from '../core/state';
import type { GitPushConfig, GitPushRepoConfig, GitUpdateCache, GitProviderName } from '../types';
import { getDefaultBranch, getRepositoryData } from './git-api';
import { buildForwardNodesFromTexts, sendForwardMessage } from './forward-message';
import { markGitDetectedVersion } from './update-registry';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

type GitUpdateType = 'commit' | 'release';

interface GitUpdateStats {
    files: number;
    additions: number;
    deletions: number;
}

interface GitUpdateItem {
    type: GitUpdateType;
    provider: GitProviderName;
    repoPath: string;
    repoName: string;
    branch?: string;
    tag?: string;
    sha?: string;
    title: string;
    message: string;
    messageHtml: string;
    url?: string;
    timestamp?: string;
    timeInfo: string;
    authorName?: string;
    committerName?: string;
    authorAvatar?: string;
    committerAvatar?: string;
    release: boolean;
    stats?: GitUpdateStats;
}

const CACHE_FILE = 'git-update-cache.json';
const RELEASE_CACHE_SCOPE = '__release__';

let gitPushCheckRunning = false;

const COMMIT_TYPES = new Set([
    'pr', 'feat', 'fix', 'docs', 'style',
    'refactor', 'perf', 'test', 'build',
    'ci', 'chore', 'revert'
]);

function loadCache(): GitUpdateCache {
    return pluginState.loadDataFile<GitUpdateCache>(CACHE_FILE, {
        commits: {},
        releases: {},
    });
}

function saveCache(cache: GitUpdateCache): void {
    pluginState.saveDataFile(CACHE_FILE, cache);
}

function getProviderToken(provider: GitProviderName): string {
    const configs = pluginState.config.gitProviders || [];
    const hit = configs.find(item => item.provider === provider);
    return hit?.token || '';
}

function escapeHtml(value: string): string {
    const map: Record<string, string> = {
        '&': '&' + 'amp;',
        '<': '&' + 'lt;',
        '>': '&' + 'gt;',
        '"': '&' + 'quot;',
        "'": '&' + '#39;'
    };

    return String(value || '').replace(/[&<>"']/g, (char) => map[char] || char);
}

function formatAbsoluteTime(raw?: string): string {
    if (!raw) return '';
    const date = new Date(raw);
    if (Number.isNaN(date.getTime())) return raw;

    const parts = new Intl.DateTimeFormat('zh-CN', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    }).formatToParts(date);

    const getPart = (type: string) => parts.find(item => item.type === type)?.value || '';
    const year = getPart('year');
    const month = getPart('month');
    const day = getPart('day');
    const hour = getPart('hour');
    const minute = getPart('minute');
    const second = getPart('second');

    if (!year || !month || !day) return new Intl.DateTimeFormat('zh-CN', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    }).format(date);

    return `${year}/${month}/${day} ${hour}:${minute}:${second}`;
}

function timeAgo(raw?: string): string {
    if (!raw) return '';
    const time = new Date(raw).getTime();
    if (Number.isNaN(time)) return raw;

    const diff = Date.now() - time;
    const minute = 60 * 1000;
    const hour = 60 * minute;
    const day = 24 * hour;
    const month = 30 * day;
    const year = 365 * day;

    if (diff < minute) return '刚刚';
    if (diff < hour) return `${Math.max(1, Math.floor(diff / minute))} 分钟前`;
    if (diff < day) return `${Math.max(1, Math.floor(diff / hour))} 小时前`;
    if (diff < month) return `${Math.max(1, Math.floor(diff / day))} 天前`;
    if (diff < year) return `${Math.max(1, Math.floor(diff / month))} 个月前`;
    return `${Math.max(1, Math.floor(diff / year))} 年前`;
}

function providerEmoji(provider: GitProviderName): string {
    switch (provider) {
        case 'GitHub':
            return 'GitHub';
        case 'Gitee':
            return 'Gitee';
        case 'Gitcode':
            return 'Gitcode';
        case 'Gitea':
            return 'Gitea';
        case 'CNB':
            return 'CNB';
        default:
            return 'Git';
    }
}

function svgToDataUri(svg: string): string {
    return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

function resolveCodeUpdateResourceDir(): string {
    const candidates = [
        path.join(MODULE_DIR, 'resources', 'CodeUpdate'),
        path.resolve(process.cwd(), 'dist/resources/CodeUpdate'),
        path.resolve(process.cwd(), 'src/resources/CodeUpdate')
    ];

    for (const candidate of candidates) {
        try {
            if (fs.existsSync(candidate)) {
                return candidate;
            }
        } catch {
            // ignore
        }
    }

    return candidates[0];
}

const RESOURCE_DIR = resolveCodeUpdateResourceDir();
const ICON_DIR = path.join(RESOURCE_DIR, 'icon');
const TEMPLATE_PATH = path.join(RESOURCE_DIR, 'index.html');

function getCurrentPluginVersion(): string {
    try {
        if (!pluginState || !pluginState.pluginManager) return '';
        const plugins = pluginState.pluginManager.getAllPlugins();
        const me = plugins.find((p: any) => p.packageJson?.name === 'napcat-plugin-update-checker');
        if (me) {
            return me.version || me.packageJson?.version || '';
        }
    } catch (e) {
        // ignore
    }
    return '';
}

function readIconAsDataUri(fileName: string, fallbackSvg: string): string {
    const filePath = path.join(ICON_DIR, fileName);
    try {
        if (fs.existsSync(filePath)) {
            return svgToDataUri(fs.readFileSync(filePath, 'utf8'));
        }
    } catch (error) {
        pluginState.logger.warn(`读取图标失败: ${filePath}`, error);
    }
    return svgToDataUri(fallbackSvg);
}

function getConfiguredProviderIconUrl(provider: GitProviderName): string {
    const list = pluginState.config.gitProviders || [];
    const providerText = String(provider || '').trim();
    if (!providerText) return '';

    const exact = list.find(item => String(item?.provider || '').trim() === providerText);
    const hit = exact || list.find(item => String(item?.provider || '').trim().toLowerCase() === providerText.toLowerCase());
    const iconUrl = String(hit?.iconUrl || '').trim();

    if (!iconUrl) return '';
    if (/^https?:\/\//i.test(iconUrl) || /^data:image\//i.test(iconUrl)) return iconUrl;
    return '';
}

function getProviderIcon(provider: GitProviderName): string {
    const configuredIconUrl = getConfiguredProviderIconUrl(provider);
    if (configuredIconUrl) return configuredIconUrl;

    const fileMap: Record<string, string> = {
        GitHub: 'GitHub.svg',
        Gitee: 'Gitee.svg',
        Gitcode: 'Gitcode.svg',
        Gitea: 'Gitea.svg',
        CNB: 'CNB.svg'
    };

    return readIconAsDataUri(
        fileMap[provider] || 'git.svg',
        `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 18 18"><rect width="18" height="18" rx="4" fill="#222"/><text x="9" y="12" text-anchor="middle" font-size="8" fill="#fff">${providerEmoji(provider)}</text></svg>`
    );
}

function getMetaIcon(type: 'branch' | 'tag' | 'sha'): string {
    const fileMap = {
        branch: 'branch.svg',
        tag: 'tag.svg',
        sha: 'sha.svg'
    };

    return readIconAsDataUri(
        fileMap[type],
        `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 13 13"><rect width="13" height="13" rx="2" fill="#666"/></svg>`
    );
}

function getNameStart(name?: string): string {
    return String(name || '?').trim().slice(0, 1).toUpperCase() || '?';
}

function formatPerson(value?: string): string {
    return `<span>${escapeHtml(value || 'Unknown')}</span>`;
}

function formatTimeInfo(
    authorName?: string,
    authorDate?: string,
    committerName?: string,
    committerDate?: string
): string {
    const author = formatPerson(authorName);
    const authorTime = `<span>${escapeHtml(timeAgo(authorDate))}</span>`;
    const committer = formatPerson(committerName || authorName);
    const committerTime = `<span>${escapeHtml(timeAgo(committerDate || authorDate))}</span>`;

    if ((authorName || '') === (committerName || authorName || '')) {
        return `${author} 提交于 ${authorTime}`;
    }

    return `${author} 编写于 ${authorTime}，并由 ${committer} 提交于 ${committerTime}`;
}

function replaceEmojiCodes(text: string): string {
    return text
        .split(':sparkles:').join('✨')
        .split(':bug:').join('🐛')
        .split(':memo:').join('📝')
        .split(':lipstick:').join('💄')
        .split(':recycle:').join('♻️')
        .split(':zap:').join('⚡')
        .split(':white_check_mark:').join('✅')
        .split(':construction_worker:').join('👷')
        .split(':wrench:').join('🔧')
        .split(':arrow_up:').join('⬆️')
        .split(':arrow_down:').join('⬇️')
        .split(':fire:').join('🔥')
        .split(':rocket:').join('🚀');
}

function parseCommitTitle(title: string): {
    type: string;
    scope?: string;
    subject: string;
    emoji?: string;
    isPr: boolean;
    prNum?: string;
} {
    const trimmed = title.trim();

    if (trimmed.toLowerCase().startsWith('merge pull request')) {
        const prMatch = trimmed.match(/#(\d+) from (\S+)/i);
        if (prMatch) {
            return {
                type: 'pr',
                subject: `合并 ${prMatch[2]}`,
                prNum: prMatch[1],
                isPr: true
            };
        }
    }

    const convRegex = /^(?:(\p{Emoji}))?\s*(\w+)(?:\(([^)]+)\))?:\s*(.+)$/iu;
    const parts = trimmed.match(convRegex);
    if (parts) {
        const [, emoji, type, scope, subject] = parts;
        if (COMMIT_TYPES.has(String(type).toLowerCase())) {
            return {
                type: String(type).toLowerCase(),
                scope: scope || '',
                subject: subject || trimmed,
                emoji: emoji || '',
                isPr: false
            };
        }
    }

    return {
        type: 'unknown',
        subject: trimmed,
        isPr: false
    };
}

function buildCommitHeadline(title: string): string {
    const parsed = parseCommitTitle(title);

    if (parsed.isPr) {
        const prNumHtml = parsed.prNum ? `<span class="pr-num">#${escapeHtml(parsed.prNum)}</span>` : '';
        return `<span class="commit-prefix prefix-pr">PR</span> <span class="head"><strong>${escapeHtml(parsed.subject)}</strong> ${prNumHtml}</span>`.trim();
    }

    if (parsed.type !== 'unknown') {
        const emojiClass = parsed.emoji ? ' has-emoji' : '';
        const scopeText = parsed.scope ? `(${escapeHtml(parsed.scope)}) ` : '';
        return `<span class="commit-prefix prefix-${escapeHtml(parsed.type)}${emojiClass}">${escapeHtml(`${parsed.emoji || ''}${parsed.type}`)}</span> <span class="head">${scopeText}${escapeHtml(parsed.subject)}</span>`.trim();
    }

    return `<span class="head">${escapeHtml(parsed.subject)}</span>`;
}

function renderInlineMarkdown(input: string): string {
    let html = escapeHtml(input);

    html = html.replace(/<br\s*\/?>/gi, '<br>');
    html = html.replace(/!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>');
    html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>');
    html = html.replace(/`([^`\n]+)`/g, '<code>$1</code>');
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/__([^_]+)__/g, '<strong>$1</strong>');
    html = html.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?]|$)/g, '$1<em>$2</em>');
    html = html.replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,!?]|$)/g, '$1<em>$2</em>');

    return html;
}

function simpleMarkdownToHtml(input: string): string {
    const normalized = String(input || '').replace(/\r\n/g, '\n').trim();
    if (!normalized) return '';

    const lines = normalized.split('\n');
    const blocks: string[] = [];
    let paragraphLines: string[] = [];
    let listType: 'ul' | 'ol' | null = null;
    let listItems: string[] = [];
    let blockquoteLines: string[] = [];
    let inCodeBlock = false;
    let codeLines: string[] = [];

    const flushParagraph = () => {
        if (paragraphLines.length === 0) return;
        blocks.push(`<p>${paragraphLines.map(line => renderInlineMarkdown(line)).join('<br>')}</p>`);
        paragraphLines = [];
    };

    const flushList = () => {
        if (!listType || listItems.length === 0) return;
        blocks.push(`<${listType}>${listItems.join('')}</${listType}>`);
        listType = null;
        listItems = [];
    };

    const flushBlockquote = () => {
        if (blockquoteLines.length === 0) return;
        blocks.push(`<blockquote>${blockquoteLines.map(line => renderInlineMarkdown(line)).join('<br>')}</blockquote>`);
        blockquoteLines = [];
    };

    const flushCodeBlock = () => {
        if (codeLines.length === 0) return;
        blocks.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
        codeLines = [];
    };

    for (const rawLine of lines) {
        const line = rawLine.trimEnd();
        const trimmed = line.trim();

        if (trimmed.startsWith('```')) {
            flushParagraph();
            flushList();
            flushBlockquote();
            if (inCodeBlock) {
                flushCodeBlock();
                inCodeBlock = false;
            } else {
                inCodeBlock = true;
            }
            continue;
        }

        if (inCodeBlock) {
            codeLines.push(line);
            continue;
        }

        if (!trimmed) {
            flushParagraph();
            flushList();
            flushBlockquote();
            continue;
        }

        if (/^---+$/.test(trimmed) || /^\*\*\*+$/.test(trimmed)) {
            flushParagraph();
            flushList();
            flushBlockquote();
            blocks.push('<hr>');
            continue;
        }

        const headingMatch = trimmed.match(/^(#{1,4})\s+(.+)$/);
        if (headingMatch) {
            flushParagraph();
            flushList();
            flushBlockquote();
            const level = Math.min(headingMatch[1].length, 4);
            blocks.push(`<h${level}>${renderInlineMarkdown(headingMatch[2])}</h${level}>`);
            continue;
        }

        const blockquoteMatch = trimmed.match(/^>\s?(.*)$/);
        if (blockquoteMatch) {
            flushParagraph();
            flushList();
            blockquoteLines.push(blockquoteMatch[1]);
            continue;
        }

        const ul = trimmed.match(/^[-*+]\s+(.+)$/);
        if (ul) {
            flushParagraph();
            flushBlockquote();
            if (listType && listType !== 'ul') flushList();
            listType = 'ul';
            listItems.push(`<li>${renderInlineMarkdown(ul[1])}</li>`);
            continue;
        }

        const ol = trimmed.match(/^\d+\.\s+(.+)$/);
        if (ol) {
            flushParagraph();
            flushBlockquote();
            if (listType && listType !== 'ol') flushList();
            listType = 'ol';
            listItems.push(`<li>${renderInlineMarkdown(ol[1])}</li>`);
            continue;
        }

        flushList();
        flushBlockquote();
        paragraphLines.push(trimmed.replace(/\s{2,}/g, ' '));
    }

    flushParagraph();
    flushList();
    flushBlockquote();
    flushCodeBlock();

    return blocks.join('');
}

function formatCommitMessage(message: string): { plain: string; html: string } {
    if (!message) {
        return {
            plain: '无提交信息',
            html: '<span class="head">无提交信息</span>'
        };
    }

    const replaced = replaceEmojiCodes(message);
    const lines = replaced.replace(/\r\n/g, '\n').split('\n');
    const firstLine = lines[0]?.trim() || '';
    const headline = buildCommitHeadline(firstLine);
    const rest = lines.slice(1).join('\n').trim();

    if (!rest) {
        return {
            plain: firstLine,
            html: headline
        };
    }

    return {
        plain: firstLine,
        html: `${headline}<br>${simpleMarkdownToHtml(rest)}`
    };
}

function formatReleaseMessage(name?: string, body?: string): { plain: string; html: string } {
    const title = name?.trim() || '未命名版本';
    const content = String(body || '').trim();

    if (!content) {
        return {
            plain: title,
            html: `<span class="head">${escapeHtml(title)}</span>`
        };
    }

    return {
        plain: title,
        html: `<span class="head">${escapeHtml(title)}</span><br>${simpleMarkdownToHtml(content)}`
    };
}

function getStats(data: any): GitUpdateStats | undefined {
    const stats = data?.stats;
    const files = data?.files;
    if (!stats || !Array.isArray(files)) return undefined;

    return {
        files: files.length,
        additions: Number(stats.additions || 0),
        deletions: Number(stats.deletions || 0)
    };
}

function buildCommitItem(
    provider: GitProviderName,
    repoPath: string,
    branch: string,
    data: any
): GitUpdateItem | null {
    if (!data) return null;
    const commit = Array.isArray(data) ? data[0] : data;
    if (!commit) return null;

    const sha = commit.sha || commit?.commit?.id || '';
    const fullMessage = commit?.commit?.message || commit?.message || '';
    const titleLine = String(fullMessage).split('\n')[0] || '暂无提交信息';
    const authorName = commit?.commit?.author?.name || commit?.author?.login || commit?.author_name || 'Unknown';
    const committerName = commit?.commit?.committer?.name || commit?.committer?.login || authorName;
    const authorDate = commit?.commit?.author?.date || commit?.created_at || commit?.committed_date;
    const committerDate = commit?.commit?.committer?.date || commit?.created_at || authorDate;
    const url = commit?.html_url || commit?.web_url || commit?.url;
    const formatted = formatCommitMessage(fullMessage);
    const shortSha = sha ? String(sha).slice(0, 5).toUpperCase() : '';
    const stats = getStats(commit);

    return {
        type: 'commit',
        provider,
        repoPath,
        repoName: repoPath,
        branch,
        sha: shortSha,
        title: `${authorName} @ ${shortSha || 'UNKNOWN'}`,
        message: titleLine,
        messageHtml: formatted.html,
        url,
        timestamp: formatAbsoluteTime(authorDate),
        timeInfo: formatTimeInfo(authorName, authorDate, committerName, committerDate),
        authorName,
        committerName,
        authorAvatar: commit?.author?.avatar_url || commit?.author?.avatar || '',
        committerAvatar: commit?.committer?.avatar_url || commit?.committer?.avatar || '',
        release: false,
        stats
    };
}

function buildReleaseItem(
    provider: GitProviderName,
    repoPath: string,
    data: any
): GitUpdateItem | null {
    if (!data) return null;
    const release = Array.isArray(data) ? data[0] : data;
    if (!release) return null;

    const tag = release.tag_name || release.name || '';
    const url = release.html_url || release.url;
    const body = release.body || '';
    const authorName = release?.author?.login || release?.author?.name || 'Unknown';
    const authorDate = release.published_at || release.created_at;
    const formatted = formatReleaseMessage(release.name || release.tag_name, body);

    return {
        type: 'release',
        provider,
        repoPath,
        repoName: repoPath,
        tag,
        title: tag ? `发布 ${tag}` : '发布新版本',
        message: String(body || '').split('\n')[0] || '暂无发布说明',
        messageHtml: formatted.html,
        url,
        timestamp: formatAbsoluteTime(authorDate),
        timeInfo: `${formatPerson(authorName)} 发布于 <span>${escapeHtml(timeAgo(authorDate))}</span>`,
        authorName,
        committerName: authorName,
        authorAvatar: release?.author?.avatar_url || '',
        committerAvatar: '',
        release: true
    };
}

function buildCacheKey(provider: GitProviderName, repoPath: string, branch?: string): string {
    return `${provider}|${repoPath}${branch ? `|${branch}` : ''}`;
}

function normalizeGitPushRepos(config: GitPushConfig): GitPushRepoConfig[] {
    if (Array.isArray(config.repos) && config.repos.length > 0) {
        const normalized = config.repos.filter(item => item && item.provider && item.owner && item.repo);
        for (const item of normalized) {
            item.commitEnabled = item.commitEnabled !== false;
            item.releaseEnabled = item.releaseEnabled === true;
            item.releaseBranch = item.releaseBranch || '';
        }
        return normalized;
    }

    if (config.provider && config.owner && config.repo) {
        return [{
            id: config.id || `${config.provider}-${config.owner}-${config.repo}`,
            provider: config.provider,
            repoUrl: config.repoUrl || '',
            owner: config.owner,
            repo: config.repo,
            commitEnabled: config.commitEnabled !== false,
            commitBranch: config.commitBranch,
            releaseEnabled: false,
            releaseBranch: config.releaseBranch || '',
        }];
    }

    return [];
}

function buildRepoUniqueKey(repo: GitPushRepoConfig): string {
    const provider = String(repo.provider || '').trim();
    const owner = String(repo.owner || '').trim().toLowerCase();
    const name = String(repo.repo || '').trim().toLowerCase();
    const commitEnabled = repo.commitEnabled === false ? '0' : '1';
    const commitBranch = String(repo.commitBranch || '').trim();
    const releaseEnabled = repo.releaseEnabled === true ? '1' : '0';
    const releaseBranch = String(repo.releaseBranch || '').trim();

    return [provider, owner, name, commitEnabled, commitBranch, releaseEnabled, releaseBranch].join('|');
}

function buildUpdateTextBlock(item: GitUpdateItem): string {
    const lines: string[] = [
        `📦 ${providerEmoji(item.provider)}仓库更新通知`,
        `仓库：${item.repoPath}`,
        `${item.release ? '最新发布' : '最新提交'}：${item.message || '暂无更新信息'}`,
        `${item.release ? '发布者' : '提交者'}：${item.authorName || 'Unknown'}`,
        `${item.release ? '发布时间' : '提交时间'}：${item.timestamp || '未知'}`
    ];

    if (item.url) {
        lines.push(`${item.release ? '发布链接' : '提交链接'}：${item.url}`);
    }

    return lines.join('\n');
}

function buildTextMessage(_config: GitPushConfig, updates: GitUpdateItem[]): string {
    return updates.map(item => buildUpdateTextBlock(item)).join('\n\n').trim();
}

function buildAvatarHtml(src: string | undefined, fallback: string, className = ''): string {
    const safeSrc = src ? escapeHtml(src) : '';
    const safeFallback = escapeHtml(fallback || '?');
    const cls = className ? ` class="${className}"` : '';
    return `<img src="${safeSrc}"${cls} data-nameStart="${safeFallback}">`;
}

function buildRenderHtml(_config: GitPushConfig, updates: GitUpdateItem[]): string {
    const itemsHtml = updates.map(item => {
        const branchMeta = item.branch || item.tag || item.sha
            ? `
            <div class="branch">
              ${(item.branch || item.tag) ? `
                <span class="branch-part">
                  <img src="${getMetaIcon(item.branch ? 'branch' : 'tag')}" class="meta-icon">
                  ${escapeHtml(item.branch || item.tag || '')}
                </span>
              ` : ''}
              ${item.sha ? `
                <span class="branch-part">
                  <img src="${getMetaIcon('sha')}" class="meta-icon">
                  ${escapeHtml(item.sha)}
                </span>
              ` : ''}
            </div>
            `
            : '';

        const statsHtml = item.stats
            ? `
            <div class="stats">
              <span class="file-count">${item.stats.files}</span> 个文件发生了变化
              ${(item.stats.additions || item.stats.deletions)
                    ? `，影响行数：<span class="additions">+${item.stats.additions}</span> <span class="deletions">-${item.stats.deletions}</span>`
                    : ''}
            </div>
            `
            : '';

        const authorAvatar = buildAvatarHtml(item.authorAvatar, getNameStart(item.authorName));
        const committerAvatar = item.committerAvatar && item.committerAvatar !== item.authorAvatar
            ? buildAvatarHtml(item.committerAvatar, getNameStart(item.committerName), 'committer-avatar')
            : '';

        return `
        <div class="item">
          <div class="title">
            <div class="text">
              <img src="${getProviderIcon(item.provider)}" class="icon">
              ${escapeHtml(item.repoName)}
              ${item.release ? '<div class="release">Releases</div>' : ''}
            </div>
            ${branchMeta}
            <div class="dec">
              <div class="avatar">
                ${authorAvatar}
                ${committerAvatar}
              </div>
              ${item.timeInfo}
            </div>
            <div class="desc">${item.messageHtml}</div>
            ${statsHtml}
          </div>
        </div>
        `;
    }).join('');

    let template = '';
    try {
        template = fs.readFileSync(TEMPLATE_PATH, 'utf8');
    } catch (error) {
        pluginState.logger.warn(`读取渲染模板失败: ${TEMPLATE_PATH}`, error);
    }

    if (!template) {
        return `<!DOCTYPE html><html lang="zh-CN"><body><div class="container">${itemsHtml}</div></body></html>`;
    }

    const pluginName = 'napcat-plugin-update-checker';
    const pluginVersion = getCurrentPluginVersion();

    let html = template
        .replace('{{itemsHtml}}', itemsHtml)
        .split('{{pluginName}}').join(escapeHtml(pluginName))
        .split('{{pluginVersion}}').join(escapeHtml(pluginVersion));

    if (!pluginVersion) {
        html = html.replace(/\s*<span class="version">v<\/span>/, '');
    }

    return html;
}

async function renderWithPuppeteer(html: string): Promise<string | null> {
    try {
        const res = await fetch('http://localhost:6099/plugin/napcat-plugin-puppeteer/api/render', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                html,
                encoding: 'base64',
                selector: '.container',
                setViewport: { width: 760, height: 800, deviceScaleFactor: 2 }
            })
        });
        const json = await res.json();
        if (json?.code === 0 && json?.data) {
            return json.data as string;
        }
    } catch (e) {
        pluginState.logger.warn('调用 puppeteer 渲染失败:', e);
    }
    return null;
}

async function sendTextMessage(targetId: string, text: string, isGroup: boolean): Promise<void> {
    const action = isGroup ? 'send_group_msg' : 'send_private_msg';
    const idKey = isGroup ? 'group_id' : 'user_id';
    const msg: unknown[] = [{ type: 'text', data: { text } }];

    await pluginState.ctx.actions.call(
        action as 'send_group_msg',
        { [idKey]: Number(targetId), message: msg } as never,
        pluginState.ctx.adapterName,
        pluginState.ctx.pluginManager.config
    ).catch((e: any) => {
        pluginState.logger.warn(`发送${isGroup ? '群' : '私聊'}消息失败:`, e);
    });
}

function buildRepoText(_config: GitPushConfig, _repoPath: string, updates: GitUpdateItem[]): string {
    return updates.map(item => buildUpdateTextBlock(item)).join('\n\n').trim();
}

function buildRepoForwardNodes(config: GitPushConfig, updates: GitUpdateItem[]): unknown[] {
    const repoMap = new Map<string, GitUpdateItem[]>();

    for (const item of updates) {
        const list = repoMap.get(item.repoPath) || [];
        list.push(item);
        repoMap.set(item.repoPath, list);
    }

    const texts = Array.from(repoMap.entries()).map(([repoPath, repoUpdates]) =>
        buildRepoText(config, repoPath, repoUpdates)
    );

    return buildForwardNodesFromTexts(texts);
}

function buildRepoForwardNodesWithNotice(
    config: GitPushConfig,
    updates: GitUpdateItem[],
    notice: string
): unknown[] {
    const repoMap = new Map<string, GitUpdateItem[]>();

    for (const item of updates) {
        const list = repoMap.get(item.repoPath) || [];
        list.push(item);
        repoMap.set(item.repoPath, list);
    }

    const texts = [
        notice,
        ...Array.from(repoMap.entries()).map(([repoPath, repoUpdates]) =>
            buildRepoText(config, repoPath, repoUpdates)
        )
    ];

    return buildForwardNodesFromTexts(texts);
}

const RENDER_FALLBACK_NOTICE = '⚠️ 渲染失败，请检查渲染插件是否安装或正常运行';

function withRenderFallbackNotice(text: string): string {
    const content = String(text || '').trim();
    return content ? `${RENDER_FALLBACK_NOTICE}\n\n${content}` : RENDER_FALLBACK_NOTICE;
}

async function sendImageMessage(targetId: string, base64: string, isGroup: boolean): Promise<void> {
    const action = isGroup ? 'send_group_msg' : 'send_private_msg';
    const idKey = isGroup ? 'group_id' : 'user_id';
    const msg: unknown[] = [{ type: 'image', data: { file: `base64://${base64}` } }];

    await pluginState.ctx.actions.call(
        action as 'send_group_msg',
        { [idKey]: Number(targetId), message: msg } as never,
        pluginState.ctx.adapterName,
        pluginState.ctx.pluginManager.config
    ).catch((e: any) => {
        pluginState.logger.warn(`发送${isGroup ? '群' : '私聊'}图片失败:`, e);
    });
}

async function sendUpdates(
    config: GitPushConfig,
    updates: GitUpdateItem[],
    overrideTargets?: { groups?: string[]; users?: string[] }
): Promise<void> {
    const groups = overrideTargets?.groups || config.notifyGroups || [];
    const users = overrideTargets?.users || config.notifyUsers || [];
    if (groups.length === 0 && users.length === 0) return;

    let renderFailed = false;
    if (config.renderMode === 'render') {
        const html = buildRenderHtml(config, updates);
        const base64 = await renderWithPuppeteer(html);
        if (base64) {
            for (const gid of groups) await sendImageMessage(gid, base64, true);
            for (const uid of users) await sendImageMessage(uid, base64, false);
            return;
        }
        renderFailed = true;
        pluginState.logger.warn('渲染推送失败，已自动降级为文本推送，请检查渲染插件是否安装或正常运行');
    }

    const repoCount = new Set(updates.map(item => item.repoPath)).size;
    const text = buildTextMessage(config, updates);

    if (renderFailed) {
        const fallbackText = withRenderFallbackNotice(text);

        if (repoCount > 1) {
            const nodes = buildRepoForwardNodesWithNotice(config, updates, RENDER_FALLBACK_NOTICE);
            for (const gid of groups) await sendForwardMessage(gid, nodes, true, () => sendTextMessage(gid, fallbackText, true));
            for (const uid of users) await sendForwardMessage(uid, nodes, false, () => sendTextMessage(uid, fallbackText, false));
            return;
        }

        for (const gid of groups) await sendTextMessage(gid, fallbackText, true);
        for (const uid of users) await sendTextMessage(uid, fallbackText, false);
        return;
    }

    if (repoCount > 1) {
        const nodes = buildRepoForwardNodes(config, updates);
        for (const gid of groups) await sendForwardMessage(gid, nodes, true, () => sendTextMessage(gid, text, true));
        for (const uid of users) await sendForwardMessage(uid, nodes, false, () => sendTextMessage(uid, text, false));
        return;
    }

    for (const gid of groups) await sendTextMessage(gid, text, true);
    for (const uid of users) await sendTextMessage(uid, text, false);
}

async function collectRepoUpdates(
    repoConfig: GitPushRepoConfig,
    cache: GitUpdateCache,
    options?: { forcePush?: boolean }
): Promise<GitUpdateItem[]> {
    const updates: GitUpdateItem[] = [];
    const repoPath = `${repoConfig.owner}/${repoConfig.repo}`;
    const token = getProviderToken(repoConfig.provider);
    let effectiveCommitBranch = repoConfig.commitBranch || '';
    const commitEnabled = repoConfig.commitEnabled !== false;

    // Commit 更新
    if (commitEnabled && (repoConfig.commitBranch || pluginState.config.gitAutoFetchDefaultBranch)) {
        let branch = repoConfig.commitBranch;
        if (!branch && pluginState.config.gitAutoFetchDefaultBranch) {
            const defaultBranch = await getDefaultBranch(repoPath, repoConfig.provider, token);
            if (defaultBranch) {
                branch = defaultBranch;
            }
        }

        if (branch) {
            effectiveCommitBranch = branch;
            const data = await getRepositoryData(repoPath, repoConfig.provider, 'commits', token, branch);
            const item = buildCommitItem(repoConfig.provider, repoPath, branch, data);
            if (item) {
                const sha = (Array.isArray(data) ? data[0]?.sha : data?.sha) || '';
                const key = buildCacheKey(repoConfig.provider, repoPath, branch);
                const lastSha = cache.commits[key];
                if (!lastSha) {
                    cache.commits[key] = sha;
                    if (options?.forcePush && sha) {
                        updates.push(item);
                        markGitDetectedVersion(repoPath, String(sha), 'git-commit');
                    }
                } else if (sha && sha !== lastSha) {
                    cache.commits[key] = sha;
                    updates.push(item);
                    markGitDetectedVersion(repoPath, String(sha), 'git-commit');
                } else if (options?.forcePush && sha) {
                    updates.push(item);
                    markGitDetectedVersion(repoPath, String(sha), 'git-commit');
                }
            }
        }
    }

    // Release 更新
    if (repoConfig.releaseEnabled) {
        let releaseBranch = String(repoConfig.releaseBranch || '').trim();
        if (!releaseBranch) {
            if (commitEnabled) {
                releaseBranch = effectiveCommitBranch || repoConfig.commitBranch || '';
            } else {
                const defaultBranch = await getDefaultBranch(repoPath, repoConfig.provider, token);
                if (defaultBranch) {
                    releaseBranch = defaultBranch;
                }
            }
        }

        const releaseData = await getRepositoryData(repoPath, repoConfig.provider, 'releases', token);
        const releaseItem = buildReleaseItem(repoConfig.provider, repoPath, releaseData);
        if (releaseItem) {
            const release = Array.isArray(releaseData) ? releaseData[0] : releaseData;
            const id = release?.node_id || release?.id || release?.tag_name || '';
            const key = buildCacheKey(repoConfig.provider, repoPath, RELEASE_CACHE_SCOPE);
            const lastId = cache.releases[key];
            if (!lastId) {
                cache.releases[key] = id;
                if (options?.forcePush && id) {
                    releaseItem.branch = releaseBranch || undefined;
                    updates.push(releaseItem);
                    markGitDetectedVersion(repoPath, String(releaseItem.tag || id), 'git-release');
                }
            } else if (id && id !== lastId) {
                cache.releases[key] = id;
                releaseItem.branch = releaseBranch || undefined;
                updates.push(releaseItem);
                markGitDetectedVersion(repoPath, String(releaseItem.tag || id), 'git-release');
            } else if (options?.forcePush && id) {
                releaseItem.branch = releaseBranch || undefined;
                updates.push(releaseItem);
                markGitDetectedVersion(repoPath, String(releaseItem.tag || id), 'git-release');
            }
        }
    }

    return updates;
}

export async function ensureGitDefaultBranches(): Promise<void> {
    // 保留兼容入口：默认分支改为运行时动态获取，不再持久化到配置文件
    return;
}

export async function runGitPushCheck(): Promise<void> {
    if (gitPushCheckRunning) {
        pluginState.logger.warn('Git 推送检查仍在进行中，本次检查已跳过以避免并发重入');
        return;
    }

    gitPushCheckRunning = true;
    try {
        const configs = (pluginState.config.gitPushConfigs || []).filter(item => item.enabled !== false);
        if (configs.length === 0) return;

        const cache = loadCache();

        // 仅对“启用中的推送列表”构建仓库集合，关闭列表不会触发任何 API 调用
        const configRepos = configs.map(config => {
            const repos = normalizeGitPushRepos(config);
            if (!Array.isArray(config.repos) || config.repos.length === 0) {
                config.repos = repos;
            }
            return { config, repos };
        });

        // 去重后只请求一次同仓库（同 provider/owner/repo/branch/release 配置）
        const repoKeyToConfig = new Map<string, GitPushRepoConfig>();
        for (const { repos } of configRepos) {
            for (const repo of repos) {
                const key = buildRepoUniqueKey(repo);
                if (!repoKeyToConfig.has(key)) {
                    repoKeyToConfig.set(key, repo);
                }
            }
        }

        const repoUpdatesMap = new Map<string, GitUpdateItem[]>();
        for (const [key, repo] of repoKeyToConfig.entries()) {
            const updates = await collectRepoUpdates(repo, cache);
            repoUpdatesMap.set(key, updates);
        }

        for (const { config, repos } of configRepos) {
            const allUpdates: GitUpdateItem[] = [];
            for (const repo of repos) {
                const key = buildRepoUniqueKey(repo);
                const updates = repoUpdatesMap.get(key) || [];
                if (updates.length > 0) {
                    allUpdates.push(...updates);
                }
            }

            if (allUpdates.length > 0) {
                await sendUpdates(config, allUpdates);
            }
        }

        saveCache(cache);
    } finally {
        gitPushCheckRunning = false;
    }
}

export async function runGitPushDebugForConfig(
    configId: string,
    target?: { groups?: string[]; users?: string[] }
): Promise<{ ok: boolean; message: string; updates: number }> {
    const configs = pluginState.config.gitPushConfigs || [];
    const config = configs.find(item => item.id === configId);
    if (!config) {
        return { ok: false, message: '未找到对应的推送列表', updates: 0 };
    }

    const repos = normalizeGitPushRepos(config);
    if (repos.length === 0) {
        return { ok: false, message: '该推送列表未配置仓库', updates: 0 };
    }

    const cache = loadCache();
    const allUpdates: GitUpdateItem[] = [];
    for (const repo of repos) {
        const updates = await collectRepoUpdates(repo, cache, { forcePush: true });
        if (updates.length > 0) {
            allUpdates.push(...updates);
        }
    }

    saveCache(cache);

    if (allUpdates.length === 0) {
        return { ok: false, message: '未获取到可推送的更新信息', updates: 0 };
    }

    await sendUpdates(config, allUpdates, target);
    return { ok: true, message: `已立即推送 ${allUpdates.length} 条更新信息`, updates: allUpdates.length };
}

export async function runGitPushDebugForGroup(
    groupId: string
): Promise<{ ok: boolean; message: string; matched: number; updates: number }> {
    const configs = (pluginState.config.gitPushConfigs || []).filter(item =>
        item.enabled !== false && Array.isArray(item.notifyGroups) && item.notifyGroups.includes(String(groupId))
    );

    if (configs.length === 0) {
        return { ok: false, message: '当前群未配置 Git 推送仓库', matched: 0, updates: 0 };
    }

    const cache = loadCache();
    let matched = 0;
    let updates = 0;

    const configRepos = configs
        .map(config => {
            const repos = normalizeGitPushRepos(config);
            return { config, repos };
        })
        .filter(item => item.repos.length > 0);

    matched = configRepos.length;

    if (matched === 0) {
        return { ok: false, message: '当前群未配置 Git 推送仓库', matched: 0, updates: 0 };
    }

    // 调试模式也做仓库去重，避免同仓库重复请求 API
    const repoKeyToConfig = new Map<string, GitPushRepoConfig>();
    for (const { repos } of configRepos) {
        for (const repo of repos) {
            const key = buildRepoUniqueKey(repo);
            if (!repoKeyToConfig.has(key)) {
                repoKeyToConfig.set(key, repo);
            }
        }
    }

    const repoUpdatesMap = new Map<string, GitUpdateItem[]>();
    for (const [key, repo] of repoKeyToConfig.entries()) {
        const repoUpdates = await collectRepoUpdates(repo, cache);
        repoUpdatesMap.set(key, repoUpdates);
    }

    for (const { config, repos } of configRepos) {
        const allUpdates: GitUpdateItem[] = [];
        for (const repo of repos) {
            const key = buildRepoUniqueKey(repo);
            const repoUpdates = repoUpdatesMap.get(key) || [];
            if (repoUpdates.length > 0) {
                allUpdates.push(...repoUpdates);
            }
        }

        if (allUpdates.length > 0) {
            await sendUpdates(config, allUpdates, { groups: [String(groupId)] });
            updates += allUpdates.length;
        }
    }

    saveCache(cache);

    return {
        ok: true,
        message: updates > 0 ? `已向当前群推送 ${updates} 条更新信息` : '已执行检测，所有仓库都是最新的~',
        matched,
        updates
    };
}
