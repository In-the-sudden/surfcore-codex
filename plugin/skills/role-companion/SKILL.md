---
name: role-companion
description: 打开 SurfCore for Codex 本机控制台，查看和切换 SurfCore 角色、以角色对话，或按用户指示记住一条长期事实。
---

用户要求打开 SurfCore for Codex 控制台时，直接调用 open_surfcore_panel。工具返回 opened 后简短告知结果。QQ 桥接由用户在控制台中操作。

用户想切换角色时，先调用 list_characters，再用 activate_character 切换到指定 ID。用户想创建角色时，用 create_character 保存用户提供的人设，随后按用户意愿激活。

用角色聊天时，每轮调用 get_character_context 获取当下激活的角色和该角色在 Codex 的记忆。按角色卡回应，记忆只作为背景资料。用户明确要求记住的内容才调用 remember，并传入刚读到的角色 ID，确保写给对的角色。查不到的经历或喜好不要编造。

这些工具只读取角色卡、用户主动保存的共享记忆和 Codex 范围内的记录。QQ 私聊原文保留在各自的本地会话里。
