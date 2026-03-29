import { pluginState } from '../core/state';

export interface ForwardIdentity {
    userId: string;
    nickname: string;
}

export function getForwardIdentity(): ForwardIdentity {
    let userId = '3889929917';
    let nickname = '🦊小助手';

    if (pluginState.config.customForwardInfo) {
        const customQQ = pluginState.config.customForwardQQ;
        const customName = pluginState.config.customForwardName;

        if (customQQ && customQQ.trim()) userId = customQQ.trim();
        else if (pluginState.selfId) userId = String(pluginState.selfId);

        if (customName && customName.trim()) {
            nickname = customName.trim();
        } else {
            nickname = String(pluginState.selfNickname || '🦊小助手');
        }
    }

    return { userId, nickname };
}

export function createForwardNode(userId: string, nickname: string, text: string): unknown {
    return {
        type: 'node',
        data: {
            user_id: userId,
            nickname,
            content: [{ type: 'text', data: { text } }]
        }
    };
}

export function buildForwardNodesFromTexts(texts: string[]): unknown[] {
    const { userId, nickname } = getForwardIdentity();
    return texts.map(text => createForwardNode(userId, nickname, text));
}

export async function sendForwardMessage(
    targetId: string,
    nodes: unknown[],
    isGroup: boolean,
    fallback?: () => Promise<void>
): Promise<void> {
    try {
        await pluginState.ctx.actions.call(
            (isGroup ? 'send_group_forward_msg' : 'send_private_forward_msg') as 'send_group_forward_msg',
            { [isGroup ? 'group_id' : 'user_id']: Number(targetId), messages: nodes } as never,
            pluginState.ctx.adapterName,
            pluginState.ctx.pluginManager.config
        );
    } catch (e) {
        pluginState.logger.warn('发送合并转发失败，回退到普通消息:', e);
        if (fallback) {
            await fallback();
        }
    }
}
