/** The transport owns the signature; persisted agent responses remain unmodified. */
export const formatWhatsAppAgentReply = (alias: string, response: string): string => {
  const prefix = `🤖 ${alias}: \n`;
  let body = response;
  while (body.startsWith(prefix)) body = body.slice(prefix.length);
  const suffix = '\n\n[Respuesta abreviada; versión completa en Forger]';
  if (prefix.length + body.length > 4000) {
    const shortened = body.slice(0, 3900 - prefix.length - suffix.length).replace(/[\uD800-\uDBFF]$/u, '').trimEnd();
    body = `${shortened}${suffix}`;
  }
  return prefix + body;
};
