const maxStickerChoices = 24;
const maxImages = 4;
const maxImageBytes = 8 * 1024 * 1024;

function modelPlan(value) {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return null; }
}

function operationText(result) {
  switch (result.status) {
    case 'saved': return '已收藏表情「' + result.label + '」。';
    case 'duplicate': return '表情已存在，原备注为「' + result.label + '」。';
    case 'full': return '本地表情库已达 200 MB 上限，这张未保存。';
    default: return '本次未保存表情。';
  }
}

export async function runConversationTurn({
  generate, generation, incoming, scope, resolved, readConversation, resolveMedia,
  stickerLibrary, canUseTools, current, onError,
}) {
  const roleId = generation.role.id;
  const mediaImages = [...resolved.images];
  const candidates = [...(resolved.stickers ?? [])];
  const context = {};
  const used = new Set();
  let canManage = Boolean(stickerLibrary);
  let canReadQuote = Boolean(readConversation && incoming.quotedMessageId);
  let canReadHistory = Boolean(readConversation);
  const listStickers = async () => {
    try { return stickerLibrary ? await stickerLibrary.list(roleId, scope) : []; }
    catch (error) { canManage = false; onError(error); return []; }
  };
  let library = await listStickers();
  let localOptions = library.slice(0, maxStickerChoices);

  const next = () => generate({
    ...generation,
    message: Object.keys(context).length ? JSON.stringify({ currentMessage: generation.message, ...context }) : generation.message,
    mediaImages,
    conversationTools: {
      canReadQuote, canReadHistory, canManage, stickerCount: candidates.length,
      canSearchStickers: library.length > maxStickerChoices && !used.has('stickers'),
      stickers: localOptions.map(({ label }, index) => ({ choice: index + 1, label })),
    },
  });

  for (let turn = 0; turn < 5; turn++) {
    if (!await canUseTools()) return null;
    const generated = await next();
    if (!await canUseTools()) return null;
    const plan = modelPlan(generated);
    if (plan?.action === 'lookup') {
      const source = plan.source;
      if (used.has(source)) return { generated, localOptions };
      if (source === 'stickers' && library.length > maxStickerChoices) {
        const query = typeof plan.query === 'string' ? plan.query.trim().slice(0, 60).toLowerCase() : '';
        const page = Number.isSafeInteger(plan.page) && plan.page > 0 ? plan.page : 1;
        const offset = (page - 1) * maxStickerChoices;
        localOptions = library.filter(({ label }) => !query || label.toLowerCase().includes(query)).slice(offset, offset + maxStickerChoices);
        context.stickerLibrary = localOptions.length ? '本地收藏搜索结果见当前表情选项。' : '本地收藏没有找到符合条件的表情。';
      } else if ((source === 'quoted' && canReadQuote) || (source === 'history' && canReadHistory)) {
        const result = await readConversation(incoming, source);
        if (!await canUseTools()) return null;
        if (source === 'quoted') {
          canReadQuote = false;
          context.quotedMessage = result.text;
          if (result.quotedMedia) {
            const media = await resolveMedia(result.quotedMedia, {
              attachmentOffset: mediaImages.length, stickerOffset: candidates.length,
              maxImages: Math.max(0, maxImages - mediaImages.length),
              maxTotalImageBytes: Math.max(0, maxImageBytes - mediaImages.reduce((sum, image) => sum + image.bytes.length, 0)),
            });
            if (!await canUseTools()) return null;
            mediaImages.push(...media.images);
            candidates.push(...(media.stickers ?? []));
            context.quotedMessage = media.text;
          }
        } else {
          canReadHistory = false;
          context.conversationHistory = result.text;
        }
      } else return { generated, localOptions };
      used.add(source);
      continue;
    }
    if (plan?.action === 'manage_sticker' && canManage) {
      canManage = false;
      const save = plan.saveSticker;
      const candidate = Number.isInteger(save?.choice) && candidates[save.choice - 1];
      const selected = Number.isInteger(plan.removeSticker) && localOptions[plan.removeSticker - 1];
      try {
        if (candidate && typeof save.label === 'string' && save.label.trim() && plan.removeSticker === undefined) {
          const result = await stickerLibrary.save(roleId, scope, { ...candidate, label: save.label }, { canWrite: current });
          context.stickerOperation = operationText(result);
        } else if (selected && save === undefined) {
          const removed = await stickerLibrary.remove(roleId, scope, selected.id, { canWrite: current });
          context.stickerOperation = removed ? '已删除所选本地表情。' : '本次未删除表情。';
        } else {
          context.stickerOperation = '没有执行收藏操作，表情选项或备注无效。';
        }
      } catch {
        context.stickerOperation = '本地表情库操作失败。';
      }
      if (!await canUseTools()) return null;
      library = await listStickers();
      localOptions = library.slice(0, maxStickerChoices);
      continue;
    }
    return { generated, localOptions };
  }
  return { generated: null, localOptions };
}
