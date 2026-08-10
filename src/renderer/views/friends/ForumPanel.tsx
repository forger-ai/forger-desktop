import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import AddRounded from '@mui/icons-material/AddRounded';
import ArrowBackRounded from '@mui/icons-material/ArrowBackRounded';
import DeleteOutlineRounded from '@mui/icons-material/DeleteOutlineRounded';
import ForumRounded from '@mui/icons-material/ForumRounded';
import ReplyRounded from '@mui/icons-material/ReplyRounded';
import SendRounded from '@mui/icons-material/SendRounded';
import VisibilityOffRounded from '@mui/icons-material/VisibilityOffRounded';
import VisibilityRounded from '@mui/icons-material/VisibilityRounded';
import {
  Alert,
  Avatar,
  Box,
  Button,
  CircularProgress,
  Divider,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  List,
  ListItemButton,
  Paper,
  Stack,
  TextField,
  Typography,
  alpha,
  useTheme,
  type AlertColor,
} from '@mui/material';
import type { ForumComment, ForumParticipationState, ForumPost } from '@shared/types';

interface ForumPanelProps {
  active: boolean;
  onNotify?: (message: string, severity?: AlertColor) => void;
  onOpenProfile?: (username: string) => void;
}

const formatForumDate = (value?: string) => {
  if (!value) return 'Ahora';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Fecha reciente';
  return date.toLocaleString('es-CL', { dateStyle: 'medium', timeStyle: 'short' });
};

const forumAuthorLabel = (author: ForumPost['author']) =>
  author.firstName || `@${author.username}`;

const placeholderBody = (status: ForumPost['status'], kind: 'post' | 'comment') => {
  if (status === 'hidden') return kind === 'post' ? 'Post oculto por moderación.' : 'Comentario oculto por moderación.';
  if (status === 'deleted') return kind === 'post' ? 'Post eliminado.' : 'Comentario eliminado.';
  return '';
};

const forumErrorMessage = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message : fallback;

export function ForumPanel({ active, onNotify, onOpenProfile }: ForumPanelProps) {
  const theme = useTheme();
  const [participation, setParticipation] = useState<ForumParticipationState | null>(null);
  const [posts, setPosts] = useState<ForumPost[]>([]);
  const [selectedPost, setSelectedPost] = useState<ForumPost | null>(null);
  const [postBody, setPostBody] = useState('');
  const [createPostOpen, setCreatePostOpen] = useState(false);
  const [commentBody, setCommentBody] = useState('');
  const [replyTargetId, setReplyTargetId] = useState<number | null>(null);
  const [replyBody, setReplyBody] = useState('');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const destructiveActionPendingRef = useRef(false);

  const isOptedIn = participation?.status === 'opted_in';
  const selectedPostId = selectedPost?.id;
  const visibleComments = useMemo(() => selectedPost?.comments ?? [], [selectedPost]);

  const loadForum = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const state = await window.forger.getForumParticipation();
      setParticipation(state);
      if (state.status === 'opted_in') {
        setPosts(await window.forger.listForumPosts(50));
      } else {
        setPosts([]);
        setSelectedPost(null);
      }
    } catch (err) {
      setError(forumErrorMessage(err, 'No pudimos cargar el foro.'));
    } finally {
      setLoading(false);
    }
  }, [active]);

  const refreshSelectedPost = useCallback(async () => {
    const next = await window.forger.getForumPost(selectedPostId!);
    setSelectedPost(next);
    setPosts((current) => current.map((post) => (post.id === next.id ? { ...post, ...next, comments: post.comments } : post)));
  }, [selectedPostId]);

  useEffect(() => {
    if (active) void loadForum();
  }, [active, loadForum]);

  const handleOptIn = async () => {
    setBusy(true);
    setError(null);
    try {
      const state = await window.forger.updateForumParticipation('opt_in');
      setParticipation(state);
      setPosts(await window.forger.listForumPosts(50));
      onNotify?.('Foro activado.', 'success');
    } catch (err) {
      setError(forumErrorMessage(err, 'No pudimos activar el foro.'));
    } finally {
      setBusy(false);
    }
  };

  const handleCreatePost = async (event: FormEvent) => {
    event.preventDefault();
    const body = postBody.trim();
    setBusy(true);
    setError(null);
    try {
      const post = await window.forger.createForumPost(body);
      setPosts((current) => [post, ...current]);
      setSelectedPost(await window.forger.getForumPost(post.id));
      setPostBody('');
      setCreatePostOpen(false);
      onNotify?.('Post publicado.', 'success');
    } catch (err) {
      setError(forumErrorMessage(err, 'No pudimos publicar el post.'));
    } finally {
      setBusy(false);
    }
  };

  const handleOpenPost = async (post: ForumPost) => {
    setBusy(true);
    setError(null);
    try {
      setSelectedPost(await window.forger.getForumPost(post.id));
    } catch (err) {
      setError(forumErrorMessage(err, 'No pudimos abrir el post.'));
    } finally {
      setBusy(false);
    }
  };

  const handleCreateComment = async (event: FormEvent) => {
    event.preventDefault();
    const body = commentBody.trim();
    const postId = selectedPost!.id;
    setBusy(true);
    setError(null);
    try {
      await window.forger.createForumComment(postId, body);
      setCommentBody('');
      await refreshSelectedPost();
      setPosts((current) => current.map((post) => post.id === postId ? { ...post, commentsCount: post.commentsCount + 1 } : post));
    } catch (err) {
      setError(forumErrorMessage(err, 'No pudimos comentar.'));
    } finally {
      setBusy(false);
    }
  };

  const handleReply = async (event: FormEvent) => {
    event.preventDefault();
    const body = replyBody.trim();
    setBusy(true);
    setError(null);
    try {
      await window.forger.replyForumComment(replyTargetId!, body);
      setReplyTargetId(null);
      setReplyBody('');
      await refreshSelectedPost();
      setPosts((current) => current.map((post) => post.id === selectedPost!.id ? { ...post, commentsCount: post.commentsCount + 1 } : post));
    } catch (err) {
      setError(forumErrorMessage(err, 'No pudimos responder.'));
    } finally {
      setBusy(false);
    }
  };

  const handlePostAction = async (currentPost: ForumPost, action: 'delete' | 'hide' | 'unhide') => {
    if (destructiveActionPendingRef.current) return;
    destructiveActionPendingRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const next = action === 'delete'
        ? await window.forger.deleteForumPost(currentPost.id)
        : await window.forger.moderateForumPost(currentPost.id, action);
      if (action === 'delete') {
        setSelectedPost(null);
        setPosts((current) => current.filter((post) => post.id !== currentPost.id));
        return;
      }
      setSelectedPost({ ...currentPost, ...next });
      setPosts((current) => current.map((post) => (post.id === next.id ? { ...post, ...next } : post)));
    } catch (err) {
      setError(forumErrorMessage(err, 'No pudimos actualizar el post.'));
    } finally {
      destructiveActionPendingRef.current = false;
      setBusy(false);
    }
  };

  const handleCommentAction = async (comment: ForumComment, action: 'delete' | 'hide' | 'unhide') => {
    if (destructiveActionPendingRef.current) return;
    destructiveActionPendingRef.current = true;
    setBusy(true);
    setError(null);
    try {
      if (action === 'delete') {
        await window.forger.deleteForumComment(comment.id);
      } else {
        await window.forger.moderateForumComment(comment.id, action);
      }
      await refreshSelectedPost();
    } catch (err) {
      setError(forumErrorMessage(err, 'No pudimos actualizar el comentario.'));
    } finally {
      destructiveActionPendingRef.current = false;
      setBusy(false);
    }
  };

  const renderComment = (comment: ForumComment) => {
    const body = comment.body ?? placeholderBody(comment.status, 'comment');
    const canReply = comment.status === 'visible' && comment.depth < 4;
    return (
      <Box key={comment.id} sx={{ pl: Math.min(comment.depth, 5) * 1.5 }}>
        <Paper
          variant="outlined"
          sx={{
            p: 1.25,
            borderRadius: 1,
            borderColor: comment.status === 'visible' ? alpha(theme.palette.divider, 0.8) : alpha(theme.palette.warning.main, 0.4),
            bgcolor: comment.status === 'visible' ? 'background.paper' : alpha(theme.palette.warning.main, 0.06),
          }}
        >
          <Stack spacing={0.75}>
            <Stack direction="row" spacing={1} alignItems="center" useFlexGap flexWrap="wrap">
              <Typography variant="body2" sx={{ fontWeight: 700 }}>{forumAuthorLabel(comment.author)}</Typography>
              <Typography variant="caption" color="text.secondary">@{comment.author.username}</Typography>
              <Typography variant="caption" color="text.secondary">{formatForumDate(comment.createdAt)}</Typography>
              {onOpenProfile ? (
                <Button size="small" onClick={() => onOpenProfile(comment.author.username)}>
                  Ver perfil
                </Button>
              ) : null}
            </Stack>
            <Typography variant="body2" color={comment.body ? 'text.primary' : 'text.secondary'} sx={{ whiteSpace: 'pre-wrap' }}>
              {body}
            </Typography>
            {comment.hiddenReason ? (
              <Typography variant="caption" color="text.secondary">Motivo: {comment.hiddenReason}</Typography>
            ) : null}
            <Stack direction="row" spacing={0.75} useFlexGap flexWrap="wrap">
              {canReply ? (
                <Button size="small" startIcon={<ReplyRounded />} disabled={busy} onClick={() => setReplyTargetId(comment.id)}>
                  Responder
                </Button>
              ) : null}
              {comment.canDelete && comment.status !== 'deleted' ? (
                <Button size="small" color="inherit" startIcon={<DeleteOutlineRounded />} disabled={busy} onClick={() => void handleCommentAction(comment, 'delete')}>
                  Eliminar
                </Button>
              ) : null}
              {comment.canModerate && comment.status === 'visible' ? (
                <Button size="small" color="warning" startIcon={<VisibilityOffRounded />} disabled={busy} onClick={() => void handleCommentAction(comment, 'hide')}>
                  Ocultar
                </Button>
              ) : null}
              {comment.canModerate && comment.status === 'hidden' ? (
                <Button size="small" color="success" startIcon={<VisibilityRounded />} disabled={busy} onClick={() => void handleCommentAction(comment, 'unhide')}>
                  Restaurar
                </Button>
              ) : null}
            </Stack>
            {replyTargetId === comment.id ? (
              <Box component="form" onSubmit={handleReply}>
                <Stack spacing={1}>
                  <TextField
                    size="small"
                    multiline
                    minRows={2}
                    value={replyBody}
                    onChange={(event) => setReplyBody(event.target.value)}
                    placeholder="Escribe una respuesta"
                    inputProps={{ maxLength: 8000 }}
                    disabled={busy}
                  />
                  <Stack direction="row" spacing={1} justifyContent="flex-end">
                    <Button size="small" disabled={busy} onClick={() => { setReplyTargetId(null); setReplyBody(''); }}>Cancelar</Button>
                    <Button size="small" type="submit" variant="contained" disabled={!replyBody.trim() || busy}>Responder</Button>
                  </Stack>
                </Stack>
              </Box>
            ) : null}
          </Stack>
        </Paper>
        {comment.replies.length > 0 ? (
          <Stack spacing={1} sx={{ mt: 1 }}>
            {comment.replies.map(renderComment)}
          </Stack>
        ) : null}
      </Box>
    );
  };

  if (loading) {
    return (
      <Stack alignItems="center" spacing={1.5} sx={{ py: 5 }}>
        <CircularProgress size={24} />
        <Typography variant="body2" color="text.secondary">Cargando foro...</Typography>
      </Stack>
    );
  }

  if (!isOptedIn) {
    return (
      <Stack spacing={1.5}>
        {error ? <Alert severity="error">{error}</Alert> : null}
        <Paper variant="outlined" sx={{ p: 2, borderRadius: 1, textAlign: 'center' }}>
          <Stack spacing={1.5} alignItems="center">
            <ForumRounded color="primary" />
            <Typography variant="body1" sx={{ fontWeight: 700 }}>Foro opcional</Typography>
            <Typography variant="body2" color="text.secondary">
              Ingresa para leer posts, publicar conversaciones y comentar con tu cuenta de Forger.
            </Typography>
            <Button variant="contained" disabled={busy} onClick={() => void handleOptIn()}>
              {busy ? 'Entrando...' : 'Entrar al foro'}
            </Button>
          </Stack>
        </Paper>
      </Stack>
    );
  }

  if (selectedPost) {
    const body = selectedPost.body ?? placeholderBody(selectedPost.status, 'post');
    return (
      <Stack spacing={1.25}>
        <Stack direction="row" spacing={1} alignItems="center">
          <Button size="small" startIcon={<ArrowBackRounded />} onClick={() => setSelectedPost(null)}>
            Volver
          </Button>
          <Box sx={{ flex: 1 }} />
          <Button size="small" onClick={() => void refreshSelectedPost()} disabled={busy}>
            Actualizar
          </Button>
        </Stack>
        {error ? <Alert severity="error">{error}</Alert> : null}
        <Paper variant="outlined" sx={{ p: 1.5, borderRadius: 1 }}>
          <Stack spacing={1}>
            <Stack direction="row" spacing={1} alignItems="center" useFlexGap flexWrap="wrap">
              <Avatar sx={{ width: 32, height: 32 }}>{forumAuthorLabel(selectedPost.author).slice(0, 1).toUpperCase()}</Avatar>
              <Typography variant="body1" sx={{ fontWeight: 700 }}>{forumAuthorLabel(selectedPost.author)}</Typography>
              <Typography variant="caption" color="text.secondary">@{selectedPost.author.username}</Typography>
              {onOpenProfile ? (
                <Button size="small" onClick={() => onOpenProfile(selectedPost.author.username)}>
                  Ver perfil
                </Button>
              ) : null}
            </Stack>
            <Typography variant="caption" color="text.secondary">{formatForumDate(selectedPost.createdAt)}</Typography>
            <Typography variant="body2" color={selectedPost.body ? 'text.primary' : 'text.secondary'} sx={{ whiteSpace: 'pre-wrap' }}>
              {body}
            </Typography>
            {selectedPost.hiddenReason ? (
              <Typography variant="caption" color="text.secondary">Motivo: {selectedPost.hiddenReason}</Typography>
            ) : null}
            <Stack direction="row" spacing={0.75} useFlexGap flexWrap="wrap">
              {selectedPost.canDelete && selectedPost.status !== 'deleted' ? (
                <Button size="small" color="inherit" startIcon={<DeleteOutlineRounded />} disabled={busy} onClick={() => void handlePostAction(selectedPost, 'delete')}>
                  Eliminar
                </Button>
              ) : null}
              {selectedPost.canModerate && selectedPost.status === 'visible' ? (
                <Button size="small" color="warning" startIcon={<VisibilityOffRounded />} disabled={busy} onClick={() => void handlePostAction(selectedPost, 'hide')}>
                  Ocultar
                </Button>
              ) : null}
              {selectedPost.canModerate && selectedPost.status === 'hidden' ? (
                <Button size="small" color="success" startIcon={<VisibilityRounded />} disabled={busy} onClick={() => void handlePostAction(selectedPost, 'unhide')}>
                  Restaurar
                </Button>
              ) : null}
            </Stack>
          </Stack>
        </Paper>
        {selectedPost.status === 'visible' ? (
          <Box component="form" onSubmit={handleCreateComment}>
            <Stack spacing={1}>
              <TextField
                size="small"
                multiline
                minRows={2}
                value={commentBody}
                onChange={(event) => setCommentBody(event.target.value)}
                placeholder="Comentar"
                inputProps={{ maxLength: 8000 }}
                disabled={busy}
              />
              <Button type="submit" variant="contained" size="small" startIcon={<SendRounded />} disabled={!commentBody.trim() || busy} sx={{ alignSelf: 'flex-end' }}>
                Comentar
              </Button>
            </Stack>
          </Box>
        ) : null}
        <Divider />
        <Stack spacing={1}>
          <Typography variant="subtitle2">Comentarios</Typography>
          {visibleComments.length === 0 ? (
            <Typography variant="body2" color="text.secondary">Aún no hay comentarios.</Typography>
          ) : visibleComments.map(renderComment)}
        </Stack>
      </Stack>
    );
  }

  return (
    <Stack spacing={1.25}>
      {error ? <Alert severity="error">{error}</Alert> : null}
      <Stack direction="row" justifyContent="flex-end">
        <Button variant="contained" size="small" startIcon={<AddRounded />} onClick={() => setCreatePostOpen(true)}>
          Crear post
        </Button>
      </Stack>
      <Divider />
      {posts.length === 0 ? (
        <Paper variant="outlined" sx={{ p: 2, borderRadius: 1, textAlign: 'center' }}>
          <Typography variant="body1" sx={{ fontWeight: 700 }}>No hay posts todavía</Typography>
          <Typography variant="body2" color="text.secondary">Publica el primer post para iniciar una conversación.</Typography>
        </Paper>
      ) : (
        <List disablePadding sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
          {posts.map((post) => (
            <Paper key={post.id} variant="outlined" sx={{ borderRadius: 1, overflow: 'hidden' }}>
              <ListItemButton onClick={() => void handleOpenPost(post)} disabled={busy} sx={{ alignItems: 'flex-start', p: 1.5 }}>
                <Stack spacing={0.75} sx={{ minWidth: 0, width: '100%' }}>
                  <Stack direction="row" spacing={1} alignItems="center" useFlexGap flexWrap="wrap">
                    <Avatar sx={{ width: 32, height: 32 }}>{forumAuthorLabel(post.author).slice(0, 1).toUpperCase()}</Avatar>
                    <Typography variant="body1" sx={{ fontWeight: 700 }} noWrap>{forumAuthorLabel(post.author)}</Typography>
                    <Typography variant="caption" color="text.secondary">@{post.author.username}</Typography>
                    {onOpenProfile ? (
                      <Button
                        size="small"
                        onClick={(event) => {
                          event.stopPropagation();
                          onOpenProfile(post.author.username);
                        }}
                      >
                        Ver perfil
                      </Button>
                    ) : null}
                  </Stack>
                  <Typography variant="body2" color={post.body ? 'text.primary' : 'text.secondary'} sx={{ whiteSpace: 'pre-wrap' }}>
                    {post.body ?? placeholderBody(post.status, 'post')}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    {formatForumDate(post.createdAt)} · {post.commentsCount} comentarios
                  </Typography>
                </Stack>
              </ListItemButton>
            </Paper>
          ))}
        </List>
      )}
      <Dialog open={createPostOpen} onClose={() => !busy && setCreatePostOpen(false)} maxWidth="sm" fullWidth>
        <Box component="form" onSubmit={handleCreatePost}>
          <DialogTitle>Crear post</DialogTitle>
          <DialogContent>
            <TextField
              autoFocus
              fullWidth
              multiline
              minRows={5}
              value={postBody}
              onChange={(event) => setPostBody(event.target.value)}
              placeholder="Publicar en el foro"
              inputProps={{ maxLength: 8000 }}
              disabled={busy}
              sx={{ mt: 1 }}
            />
          </DialogContent>
          <DialogActions>
            <Button disabled={busy} onClick={() => { setCreatePostOpen(false); setPostBody(''); }}>Cancelar</Button>
            <Button type="submit" variant="contained" startIcon={<SendRounded />} disabled={!postBody.trim() || busy}>
              Publicar
            </Button>
          </DialogActions>
        </Box>
      </Dialog>
    </Stack>
  );
}
