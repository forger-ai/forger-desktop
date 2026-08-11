import { act, render, screen, waitFor, waitForElementToBeRemoved, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ForumComment, ForumParticipationState, ForumPost } from '@shared/types';
import { ForumPanel } from '@renderer/views/friends/ForumPanel';

const optedIn: ForumParticipationState = { status: 'opted_in', isModerator: true };
const optedOut: ForumParticipationState = { status: 'opted_out', isModerator: false };

const author = (id: number, username: string, firstName?: string) => ({ id, username, firstName });

const comment = (id: number, overrides: Partial<ForumComment> = {}): ForumComment => ({
  id,
  forumPostId: 1,
  status: 'visible',
  body: `Comment ${id}`,
  author: author(id + 10, `commenter-${id}`, id === 1 ? 'Ana' : undefined),
  canDelete: true,
  canModerate: true,
  createdAt: '2026-08-10T10:00:00.000Z',
  depth: 0,
  replies: [],
  ...overrides,
});

const post = (id: number, overrides: Partial<ForumPost> = {}): ForumPost => ({
  id,
  status: 'visible',
  body: `Post ${id}`,
  author: author(id, `author-${id}`, id === 1 ? 'Alex' : undefined),
  canDelete: true,
  canModerate: true,
  createdAt: '2026-08-10T10:00:00.000Z',
  commentsCount: 0,
  comments: [],
  ...overrides,
});

const fullPost = post(1, {
  body: 'Visible body',
  commentsCount: 3,
  comments: [
    comment(1, {
      body: 'Visible comment',
      replies: [comment(2, {
        status: 'hidden', body: undefined, hiddenReason: 'Needs review', depth: 1,
      })],
    }),
    comment(3, { status: 'deleted', body: undefined, depth: 4, canDelete: false, canModerate: false, createdAt: undefined as unknown as string }),
  ],
});

const forumApi = () => ({
  getForumParticipation: vi.fn<() => Promise<ForumParticipationState>>(),
  updateForumParticipation: vi.fn<(action: string) => Promise<ForumParticipationState>>(),
  listForumPosts: vi.fn<(limit?: number) => Promise<ForumPost[]>>(),
  getForumPost: vi.fn<(id: number) => Promise<ForumPost>>(),
  createForumPost: vi.fn<(body: string) => Promise<ForumPost>>(),
  createForumComment: vi.fn<(id: number, body: string) => Promise<ForumComment>>(),
  replyForumComment: vi.fn<(id: number, body: string) => Promise<ForumComment>>(),
  deleteForumPost: vi.fn<(id: number) => Promise<ForumPost>>(),
  moderateForumPost: vi.fn<(id: number, action: 'hide' | 'unhide') => Promise<ForumPost>>(),
  deleteForumComment: vi.fn<(id: number) => Promise<ForumComment>>(),
  moderateForumComment: vi.fn<(id: number, action: 'hide' | 'unhide') => Promise<ForumComment>>(),
});

let api: ReturnType<typeof forumApi>;
let previousForger: typeof window.forger;

beforeEach(() => {
  previousForger = window.forger;
  api = forumApi();
  Object.defineProperty(window, 'forger', { configurable: true, value: api });
});

afterEach(() => {
  Object.defineProperty(window, 'forger', { configurable: true, value: previousForger });
});

const loadOptedIn = (posts: ForumPost[] = []) => {
  api.getForumParticipation.mockResolvedValue(optedIn);
  api.listForumPosts.mockResolvedValue(posts);
  api.getForumPost.mockResolvedValue(fullPost);
};

describe('ForumPanel participation and loading', () => {
  it('does not load while inactive and opts in with feedback', async () => {
    const user = userEvent.setup();
    const onNotify = vi.fn();
    api.updateForumParticipation.mockResolvedValue(optedIn);
    api.listForumPosts.mockResolvedValue([]);
    render(<ForumPanel active={false} onNotify={onNotify} />);
    expect(api.getForumParticipation).not.toHaveBeenCalled();
    expect(screen.getByText('Foro opcional')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Entrar al foro' }));
    expect(api.updateForumParticipation).toHaveBeenCalledWith('opt_in');
    await screen.findByText('No hay posts todavía');
    expect(onNotify).toHaveBeenCalledWith('Foro activado.', 'success');
  });

  it('loads opted-out state and contains both Error and unknown failures', async () => {
    api.getForumParticipation.mockResolvedValueOnce(optedOut);
    const { rerender } = render(<ForumPanel active />);
    expect(screen.getByText('Cargando foro...')).toBeVisible();
    await screen.findByText('Foro opcional');
    expect(api.listForumPosts).not.toHaveBeenCalled();

    api.getForumParticipation.mockRejectedValueOnce(new Error('Forum offline'));
    rerender(<ForumPanel active={false} />);
    rerender(<ForumPanel active />);
    expect(await screen.findByText('Forum offline')).toBeVisible();

    api.updateForumParticipation.mockRejectedValueOnce('unsafe detail');
    await userEvent.click(screen.getByRole('button', { name: 'Entrar al foro' }));
    expect(await screen.findByText('No pudimos activar el foro.')).toBeVisible();
  });
});

describe('ForumPanel posts and comments', () => {
  it('lists every post placeholder and opens profiles without opening the row', async () => {
    const user = userEvent.setup();
    const onOpenProfile = vi.fn();
    const posts = [
      post(1, { body: 'Visible body', commentsCount: 2 }),
      post(2, { status: 'hidden', body: undefined, createdAt: 'invalid-date' }),
      post(3, { status: 'deleted', body: undefined, createdAt: undefined as unknown as string, canDelete: false, canModerate: false }),
      post(4, { status: 'visible', body: undefined }),
    ];
    loadOptedIn(posts);
    render(<ForumPanel active onOpenProfile={onOpenProfile} />);
    await screen.findByText('Visible body');
    expect(screen.getByText('Post oculto por moderación.')).toBeVisible();
    expect(screen.getByText('Post eliminado.')).toBeVisible();
    expect(screen.getByText('Fecha reciente', { exact: false })).toBeVisible();
    expect(screen.getByText('Ahora', { exact: false })).toBeVisible();

    await user.click(screen.getAllByRole('button', { name: 'Ver perfil' })[0]);
    expect(onOpenProfile).toHaveBeenCalledWith('author-1');
    expect(api.getForumPost).not.toHaveBeenCalled();
  });

  it('opens a post, refreshes, comments, replies, and invokes every comment action', async () => {
    const user = userEvent.setup();
    const onOpenProfile = vi.fn();
    loadOptedIn([post(1, { body: 'Visible body', commentsCount: 3 }), post(8, { body: 'Sibling post' })]);
    api.createForumComment.mockResolvedValue(comment(10));
    api.replyForumComment.mockResolvedValue(comment(11));
    api.deleteForumComment.mockResolvedValue(comment(1, { status: 'deleted' }));
    api.moderateForumComment.mockImplementation(async (_id, action) => comment(1, { status: action === 'hide' ? 'hidden' : 'visible' }));
    render(<ForumPanel active onOpenProfile={onOpenProfile} />);
    await user.click(await screen.findByRole('button', { name: /Visible body/ }));
    expect(await screen.findByText('Visible comment')).toBeVisible();
    expect(screen.getByText('Comentario oculto por moderación.')).toBeVisible();
    expect(screen.getByText('Comentario eliminado.')).toBeVisible();
    expect(screen.getByText('Motivo: Needs review')).toBeVisible();

    await user.click(screen.getAllByRole('button', { name: 'Ver perfil' })[0]);
    expect(onOpenProfile).toHaveBeenCalled();
    const visibleCard = screen.getByText('Visible comment').closest('.MuiPaper-outlined') as HTMLElement;
    await user.click(within(visibleCard).getByRole('button', { name: 'Ver perfil' }));
    expect(onOpenProfile).toHaveBeenCalledWith('commenter-1');
    await user.click(screen.getByRole('button', { name: 'Actualizar' }));
    expect(api.getForumPost).toHaveBeenCalledTimes(2);

    await user.type(screen.getByPlaceholderText('Comentar'), 'A useful comment');
    await user.click(screen.getByRole('button', { name: 'Comentar' }));
    await waitFor(() => expect(api.createForumComment).toHaveBeenCalledWith(1, 'A useful comment'));
    api.createForumComment.mockRejectedValueOnce(new Error('Comment failed'));
    await user.type(screen.getByPlaceholderText('Comentar'), 'Failing comment');
    await user.click(screen.getByRole('button', { name: 'Comentar' }));
    expect(await screen.findByText('Comment failed')).toBeVisible();

    await user.click(within(visibleCard).getByRole('button', { name: 'Responder' }));
    await user.click(within(visibleCard).getByRole('button', { name: 'Cancelar' }));
    await user.click(within(visibleCard).getByRole('button', { name: 'Responder' }));
    await user.type(within(visibleCard).getByPlaceholderText('Escribe una respuesta'), 'Nested reply');
    await user.click(within(visibleCard).getAllByRole('button', { name: 'Responder' }).at(-1)!);
    await waitFor(() => expect(api.replyForumComment).toHaveBeenCalledWith(1, 'Nested reply'));
    api.replyForumComment.mockRejectedValueOnce(new Error('Reply failed'));
    await user.click(within(visibleCard).getByRole('button', { name: 'Responder' }));
    await user.type(within(visibleCard).getByPlaceholderText('Escribe una respuesta'), 'Failing reply');
    await user.click(within(visibleCard).getAllByRole('button', { name: 'Responder' }).at(-1)!);
    expect(await screen.findByText('Reply failed')).toBeVisible();
    await user.click(within(visibleCard).getByRole('button', { name: 'Cancelar' }));

    let resolveDeleteComment!: (value: ForumComment) => void;
    api.deleteForumComment.mockReturnValueOnce(new Promise((resolve) => { resolveDeleteComment = resolve; }));
    await user.click(within(visibleCard).getByRole('button', { name: 'Eliminar' }));
    await waitFor(() => expect(api.deleteForumComment).toHaveBeenCalledWith(1));
    expect(within(visibleCard).getByRole('button', { name: 'Ocultar' })).toBeDisabled();
    resolveDeleteComment(comment(1, { status: 'deleted' }));
    await waitFor(() => expect(within(visibleCard).getByRole('button', { name: 'Ocultar' })).toBeEnabled());

    api.deleteForumComment.mockRejectedValueOnce(new Error('Comment action failed'));
    await user.click(within(visibleCard).getByRole('button', { name: 'Eliminar' }));
    expect(await screen.findByText('Comment action failed')).toBeVisible();
    await user.click(within(visibleCard).getByRole('button', { name: 'Eliminar' }));
    await waitFor(() => expect(api.deleteForumComment).toHaveBeenCalledWith(1));
    await user.click(within(visibleCard).getByRole('button', { name: 'Ocultar' }));
    await waitFor(() => expect(api.moderateForumComment).toHaveBeenCalledWith(1, 'hide'));
    const hiddenCard = screen.getByText('Comentario oculto por moderación.').closest('.MuiPaper-outlined') as HTMLElement;
    await user.click(within(hiddenCard).getByRole('button', { name: 'Restaurar' }));
    await waitFor(() => expect(api.moderateForumComment).toHaveBeenCalledWith(2, 'unhide'));
    await user.click(screen.getByRole('button', { name: 'Volver' }));
    expect(await screen.findByText('Sibling post')).toBeVisible();
  });

  it('keeps post moderation single-flight while the request is pending', async () => {
    const user = userEvent.setup();
    loadOptedIn([post(1, { body: 'Visible body' })]);
    let resolveModeration!: (value: ForumPost) => void;
    api.moderateForumPost.mockReturnValue(new Promise((resolve) => { resolveModeration = resolve; }));
    render(<ForumPanel active />);

    await user.click(await screen.findByRole('button', { name: /Visible body/ }));
    const postCard = (await screen.findByText('Visible body')).closest('.MuiPaper-outlined') as HTMLElement;
    const hide = within(postCard).getByRole('button', { name: 'Ocultar' });
    act(() => {
      hide.click();
      hide.click();
    });

    expect(api.moderateForumPost).toHaveBeenCalledTimes(1);
    expect(api.moderateForumPost).toHaveBeenCalledWith(1, 'hide');
    expect(hide).toBeDisabled();

    await act(async () => resolveModeration({ ...fullPost, status: 'hidden', body: undefined }));
    expect(await within(postCard).findByRole('button', { name: 'Restaurar' })).toBeEnabled();
  });

  it('keeps comment deletion single-flight while the request is pending', async () => {
    const user = userEvent.setup();
    loadOptedIn([post(1, { body: 'Visible body' })]);
    let resolveDeletion!: (value: ForumComment) => void;
    api.deleteForumComment.mockReturnValue(new Promise((resolve) => { resolveDeletion = resolve; }));
    render(<ForumPanel active />);

    await user.click(await screen.findByRole('button', { name: /Visible body/ }));
    const visibleCard = (await screen.findByText('Visible comment')).closest('.MuiPaper-outlined') as HTMLElement;
    const remove = within(visibleCard).getByRole('button', { name: 'Eliminar' });
    act(() => {
      remove.click();
      remove.click();
    });

    expect(api.deleteForumComment).toHaveBeenCalledTimes(1);
    expect(api.deleteForumComment).toHaveBeenCalledWith(1);
    expect(remove).toBeDisabled();

    await act(async () => resolveDeletion(comment(1, { status: 'deleted', body: undefined })));
    await waitFor(() => expect(api.getForumPost).toHaveBeenCalledTimes(2));
  });

  it('creates and cancels a post, then moderates and deletes the selected post', async () => {
    const user = userEvent.setup();
    const onNotify = vi.fn();
    loadOptedIn([post(8, { body: 'Sibling post' })]);
    let resolveCreate!: (value: ForumPost) => void;
    api.createForumPost.mockReturnValue(new Promise((resolve) => { resolveCreate = resolve; }));
    api.getForumPost.mockResolvedValue(post(9, { body: 'New discussion' }));
    api.moderateForumPost.mockImplementation(async (_id, action) => post(9, {
      body: action === 'hide' ? undefined : 'New discussion',
      status: action === 'hide' ? 'hidden' : 'visible',
      hiddenReason: action === 'hide' ? 'Moderator review' : undefined,
    }));
    api.deleteForumPost.mockResolvedValue(post(9, { status: 'deleted', body: undefined }));
    render(<ForumPanel active onNotify={onNotify} />);
    await screen.findByText('Sibling post');

    await user.click(screen.getByRole('button', { name: 'Crear post' }));
    const firstDialog = screen.getByRole('dialog', { name: 'Crear post' });
    expect(within(firstDialog).getByRole('button', { name: 'Publicar' })).toBeDisabled();
    await user.type(within(firstDialog).getByPlaceholderText('Publicar en el foro'), 'Discard this');
    await user.click(within(firstDialog).getByRole('button', { name: 'Cancelar' }));
    await waitForElementToBeRemoved(firstDialog);

    await user.click(screen.getByRole('button', { name: 'Crear post' }));
    const escapeDialog = screen.getByRole('dialog', { name: 'Crear post' });
    await user.keyboard('{Escape}');
    await waitForElementToBeRemoved(escapeDialog);

    await user.click(screen.getByRole('button', { name: 'Crear post' }));
    const dialog = screen.getByRole('dialog', { name: 'Crear post' });
    await user.type(within(dialog).getByPlaceholderText('Publicar en el foro'), 'New discussion');
    await user.click(within(dialog).getByRole('button', { name: 'Publicar' }));
    await waitFor(() => expect(api.createForumPost).toHaveBeenCalledWith('New discussion'));
    await user.keyboard('{Escape}');
    expect(screen.getByRole('dialog', { name: 'Crear post' })).toBeVisible();
    resolveCreate(post(9, { body: 'New discussion' }));
    await waitForElementToBeRemoved(dialog);
    expect(screen.getByText('New discussion')).toBeVisible();
    expect(api.createForumPost).toHaveBeenCalledWith('New discussion');
    expect(onNotify).toHaveBeenCalledWith('Post publicado.', 'success');

    const postCard = screen.getByText('New discussion').closest('.MuiPaper-outlined') as HTMLElement;
    api.moderateForumPost.mockRejectedValueOnce(new Error('Post action failed'));
    await user.click(await within(postCard).findByRole('button', { name: 'Ocultar' }));
    expect(await screen.findByText('Post action failed')).toBeVisible();
    await user.click(await within(postCard).findByRole('button', { name: 'Ocultar' }));
    expect(await screen.findByText('Post oculto por moderación.')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Restaurar' }));
    expect(await screen.findByText('New discussion')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Eliminar' }));
    expect(await screen.findByText('Sibling post')).toBeVisible();
  });

  it('shows a deleted selected post without mutation or comment controls', async () => {
    const user = userEvent.setup();
    const deleted = post(3, {
      status: 'deleted', body: undefined, canDelete: false, canModerate: false,
      comments: [comment(4, { body: 'Read-only comment', canDelete: false, canModerate: false })],
    });
    loadOptedIn([deleted]);
    api.getForumPost.mockResolvedValue(deleted);
    render(<ForumPanel active />);
    await user.click(await screen.findByRole('button', { name: /Post eliminado/ }));
    expect(screen.getByText('Post eliminado.')).toBeVisible();
    expect(screen.queryByPlaceholderText('Comentar')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Eliminar' })).not.toBeInTheDocument();
    expect(screen.getByText('Read-only comment')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Ver perfil' })).not.toBeInTheDocument();
  });

  it('contains open, publish, comment, reply, post-action, and comment-action failures', async () => {
    const user = userEvent.setup();
    loadOptedIn([post(1, { body: 'Visible body' })]);
    api.getForumPost.mockRejectedValueOnce(new Error('Cannot open'));
    render(<ForumPanel active />);
    await user.click(await screen.findByRole('button', { name: /Visible body/ }));
    expect(await screen.findByText('Cannot open')).toBeVisible();

    api.createForumPost.mockRejectedValueOnce('unsafe');
    await user.click(screen.getByRole('button', { name: 'Crear post' }));
    const dialog = screen.getByRole('dialog', { name: 'Crear post' });
    await user.type(within(dialog).getByPlaceholderText('Publicar en el foro'), 'Will fail');
    await user.click(within(dialog).getByRole('button', { name: 'Publicar' }));
    expect(await screen.findByText('No pudimos publicar el post.')).toBeVisible();
  });
});
