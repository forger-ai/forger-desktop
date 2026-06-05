---
name: forger-whatsapp
description: Use when the person asks to connect, list, read, inspect, or send WhatsApp messages through Forger-owned unofficial WhatsApp tools.
---

- Use only these MCP actions on the `forger` server: `whatsapp.connection.status`, `whatsapp.start_pairing`, `whatsapp.list_chats`, `whatsapp.read_messages`, `whatsapp.download_attachment`, `whatsapp.send_message`, and `whatsapp.get_chat_details`.
- WhatsApp support is unofficial and based on a local WhatsApp Web connection. It can need reconnection and must not be described as guaranteed or enterprise-grade.
- Use `whatsapp.start_pairing` only when the person wants to connect WhatsApp. Return the QR or pairing code as the user-facing connection step.
- Use `whatsapp.list_chats` and `whatsapp.read_messages` before sending. `whatsapp.send_message` must use a `chatId` returned by prior WhatsApp tool output.
- If a message has attachments, use `whatsapp.download_attachment` only with an `attachmentId` returned by `whatsapp.read_messages`. Do not invent attachment IDs or file paths.
- Treat direct chats, groups, and channels as distinct surfaces. Group participants, ephemeral settings, and channel metadata are best-effort and may be incomplete.
- Sending messages requires visible approval through Forger. If approval is denied or unavailable, stop and explain the message was not sent.
