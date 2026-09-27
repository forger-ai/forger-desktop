import type {
  ConfigureRepositoryCollaborationGroupInput,
  RepositoryCollaborationGroup,
  RepositoryCollaborationTask,
  SetRepositoryCollaborationAccessInput,
} from '../../shared/types/repository-collaboration';
import { parseCollaborationCommand, selectRepositories } from './commands';
import {
  rootsOverlap,
  validateRepositoryName,
  validateRepositoryRoot,
} from './repository-validation';
import { RepositoryCollaborationStore } from './store';
import type {
  LocalRepository,
  RepositoryCollaborationMessage,
  RepositoryCollaborationTransport,
  RepositoryExecutor,
} from './types';
const PREFIX = '🤖 Forger';
const MAX_PROMPT_LENGTH = 12000;
const MAX_QUEUED_PER_GROUP = 100;
const STATUS_LABELS: Record<RepositoryCollaborationTask['status'], string> = {
  queued: 'en cola / queued',
  running: 'en curso / running',
  cancelling: 'cancelando / cancelling',
  completed: 'terminada / completed',
  cancelled: 'cancelada / cancelled',
  failed: 'necesita revisión / failed',
  needs_attention: 'requiere revisión local / review needed',
};
const reference = (task: RepositoryCollaborationTask) =>
  `#${task.id.slice(0, 8)}`;
const publicRepository = ({ id, groupId, name }: LocalRepository) => ({
  id,
  groupId,
  name,
});
export class RepositoryCollaborationService {
  private readonly store: RepositoryCollaborationStore;
  private readonly executor: RepositoryExecutor;
  private readonly transport: RepositoryCollaborationTransport;
  private readonly now: () => number;
  private started = false;
  private outputFlush: Promise<void> | null = null;
  private readonly runs = new Set<Promise<void>>();
  private timer?: ReturnType<typeof setInterval>;
  private intake = Promise.resolve();
  private readonly active = new Map<
    string,
    {
      controller: AbortController;
      roots: string[];
    }
  >();
  constructor(options: {
    store: RepositoryCollaborationStore;
    executor: RepositoryExecutor;
    transport: RepositoryCollaborationTransport;
    now?: () => number;
  }) {
    this.store = options.store;
    this.executor = options.executor;
    this.transport = options.transport;
    this.now = options.now ?? Date.now;
  }
  start(): void {
    if (this.started) return;
    this.store.recoverInterrupted(this.now());
    this.started = true;
    this.timer = setInterval(() => {
      this.pump();
      void this.flushOutbox();
      void this.refreshMembership();
    }, 10000);
    this.timer.unref?.();
    this.pump();
    void this.flushOutbox();
  }
  async stop(): Promise<void> {
    this.started = false;
    clearInterval(this.timer);
    for (const [taskId, running] of this.active) {
      // Reservations can still be waiting for membership or repository preflight.
      // Only a run that actually started has ambiguous execution state.
      if (this.store.task(taskId)?.status === 'running') {
        this.store.updateTask(
          taskId,
          {
            status: 'needs_attention',
            errorCode: 'interrupted',
            result:
              'La ejecución se interrumpió. Revisa los cambios antes de reintentar.',
          },
          this.now(),
        );
      }
      running.controller.abort();
    }
    await this.intake;
    await Promise.allSettled([...this.runs]);
    await this.outputFlush;
  }
  snapshot(connectionId: string) {
    return this.store.snapshot(connectionId);
  }
  listGroups(connectionId: string) {
    return this.transport.listGroups(connectionId);
  }
  listParticipants(connectionId: string, chatId: string) {
    return this.transport.listParticipants(connectionId, chatId);
  }
  private requireGroup(groupId: string): RepositoryCollaborationGroup {
    const group = this.store.group(groupId);
    if (!group) throw new Error('El grupo no está configurado.');
    return group;
  }
  async configureGroup(input: ConfigureRepositoryCollaborationGroupInput) {
    const previous = this.store.findGroup(input.connectionId, input.chatId);
    if (!previous || input.enabled) {
      const chats = await this.listGroups(input.connectionId);
      if (!chats.some((chat) => chat.chatId === input.chatId))
        throw new Error('El grupo no está disponible en esta conexión.');
    }
    if (input.enabled) {
      const configured = previous && this.store.snapshot(input.connectionId);
      const members = await this.listParticipants(
        input.connectionId,
        input.chatId,
      );
      if (
        !previous ||
        !configured ||
        !configured.grants.some(
          (grant) =>
            grant.groupId === previous.id &&
            members.some(
              (member) => member.participantId === grant.participantId,
            ),
        )
      ) {
        throw new Error(
          'Agrega un proyecto y autoriza al menos una persona antes de activar el grupo.',
        );
      }
    }
    const group = this.store.configureGroup(
      { ...input, title: input.title.slice(0, 160) },
      this.now(),
    );
    this.cancelUnauthorized();
    this.pump();
    return group;
  }
  async addRepository(input: { groupId: string; name: string; root: string }) {
    this.requireGroup(input.groupId);
    const name = validateRepositoryName(input.name);
    const root = await validateRepositoryRoot(input.root);
    if (
      this.store
        .repositories(input.groupId)
        .some(
          (repo) =>
            repo.name.toLocaleLowerCase() === name.toLocaleLowerCase() ||
            repo.root === root,
        )
    ) {
      throw new Error('Ese proyecto o nombre ya está vinculado al grupo.');
    }
    return publicRepository(
      this.store.addRepository(input.groupId, name, root),
    );
  }
  async removeRepository(input: {
    groupId: string;
    repositoryId: string;
  }): Promise<void> {
    this.requireGroup(input.groupId);
    this.store.removeRepository(input.groupId, input.repositoryId);
    this.cancelUnauthorized();
  }
  async setAccess(input: SetRepositoryCollaborationAccessInput): Promise<void> {
    const group = this.requireGroup(input.groupId);
    // Removal remains possible when the account is offline or a member has left.
    if (input.repositoryIds.length) {
      const participants = await this.listParticipants(
        group.connectionId,
        group.chatId,
      );
      if (
        !participants.some(
          (person) => person.participantId === input.participantId,
        )
      )
        throw new Error('La persona ya no pertenece al grupo.');
    }
    const repositories = this.store.repositories(group.id);
    if (
      input.repositoryIds.some(
        (repoId) => !repositories.some((repo) => repo.id === repoId),
      )
    )
      throw new Error('Selecciona proyectos vinculados a este grupo.');
    const previousGrants = this.store.allowedRepositoryIds(
      input.groupId,
      input.participantId,
    );
    const removedGrants = previousGrants.filter(
      (id) => !input.repositoryIds.includes(id),
    );
    this.store.setAccess({
      ...input,
      displayName: input.displayName.slice(0, 160),
    });
    if (removedGrants.length) {
      for (const output of this.store
        .outbox()
        .filter(
          (output) =>
            output.groupId === input.groupId && output.status === 'pending',
        )) {
        const task = output.taskId ? this.store.task(output.taskId) : undefined;
        if (
          output.participantId === input.participantId ||
          task?.repositoryIds.some((id) => removedGrants.includes(id))
        )
          this.store.updateOutput(output.id, 'suppressed');
      }
    }
    this.cancelUnauthorized();
    this.pump();
  }
  private allowed(task: RepositoryCollaborationTask): boolean {
    const group = this.store.group(task.groupId);
    const grants = this.store.allowedRepositoryIds(
      task.groupId,
      task.participantId,
    );
    return (
      !!group?.enabled &&
      task.repositoryIds.length > 0 &&
      task.repositoryIds.every((id) => grants.includes(id))
    );
  }
  private async refreshMembership(): Promise<void> {
    for (const task of this.store
      .tasks()
      .filter((task) => task.status === 'running')) {
      const group = this.store.group(task.groupId);
      try {
        const member =
          group && (await this.isMember(group, task.participantId));
        if (!this.started) return;
        if (!member) this.cancel(task);
      } catch {
        // Loss of roster visibility cannot justify an ongoing unattended write.
        if (this.started) this.cancel(task);
      }
    }
  }
  private cancelUnauthorized(): void {
    for (const task of this.store.tasks()) {
      if (
        (task.status === 'queued' || task.status === 'running') &&
        !this.allowed(task)
      )
        this.cancel(task);
    }
    for (const output of this.store
      .outbox()
      .filter((output) => output.status === 'pending')) {
      const task = output.taskId ? this.store.task(output.taskId) : undefined;
      if (
        !this.store.group(output.groupId)?.enabled ||
        !this.store.allowedRepositoryIds(output.groupId, output.participantId)
          .length ||
        (task && !this.allowed(task))
      )
        this.store.updateOutput(output.id, 'suppressed');
    }
  }
  private cancel(snapshot: RepositoryCollaborationTask): void {
    const task = this.store.task(snapshot.id);
    // Membership lookups can finish after a task completes or shutdown interrupts it.
    if (!task || (task.status !== 'queued' && task.status !== 'running'))
      return;
    this.store.updateTask(
      task.id,
      {
        status: this.active.has(task.id) ? 'cancelling' : 'cancelled',
        result:
          'La tarea se canceló. Los cambios ya realizados requieren revisión local.',
      },
      this.now(),
    );
    this.active.get(task.id)?.controller.abort();
    for (const output of this.store
      .outbox()
      .filter(
        (output) => output.taskId === task.id && output.status === 'pending',
      ))
      this.store.updateOutput(output.id, 'suppressed');
    // Continuations cannot outlive cancellation of the work they depend on.
    for (const child of this.store
      .tasks()
      .filter((candidate) => candidate.parentTaskId === task.id))
      this.cancel(child);
  }
  async cancelTask(input: { taskId: string }): Promise<void> {
    const task = this.store.task(input.taskId);
    if (!task) throw new Error('La tarea no está disponible.');
    this.cancel(task);
  }
  async retryTask(input: { taskId: string }): Promise<void> {
    const task = this.store.task(input.taskId);
    if (
      !task ||
      !['failed', 'cancelled', 'needs_attention'].includes(task.status)
    )
      throw new Error('Esta tarea no necesita reintentarse.');
    const group = this.requireGroup(task.groupId);
    if (
      !this.allowed(task) ||
      !(await this.isMember(group, task.participantId))
    )
      throw new Error(
        'La persona no tiene acceso a todos los proyectos de la tarea.',
      );
    this.store.createTask(
      {
        groupId: task.groupId,
        participantId: task.participantId,
        participantName: task.participantName,
        repositoryIds: task.repositoryIds,
        prompt: task.prompt,
        sourceMessageId: task.sourceMessageId,
      },
      this.now(),
    );
    this.pump();
  }
  private async isMember(
    group: RepositoryCollaborationGroup,
    participantId: string,
  ): Promise<boolean> {
    return (await this.listParticipants(group.connectionId, group.chatId)).some(
      (person) => person.participantId === participantId,
    );
  }
  handleMessage(message: RepositoryCollaborationMessage): Promise<void> {
    if (!this.started) return Promise.resolve();
    const next = this.intake.then(() =>
      this.started ? this.acceptMessage(message) : undefined,
    );
    this.intake = next.catch(() => undefined);
    return next;
  }
  private output(
    group: RepositoryCollaborationGroup,
    participantId: string,
    text: string,
    task?: RepositoryCollaborationTask,
    replyToMessageId?: string,
  ): void {
    this.store.enqueueOutput({
      groupId: group.id,
      participantId,
      text: `${PREFIX} ${text}`,
      taskId: task?.id,
      replyToMessageId,
    });
    void this.flushOutbox();
  }
  private resolveTask(
    groupId: string,
    taskId: string,
  ): RepositoryCollaborationTask | undefined {
    const matches = this.store
      .tasks()
      .filter(
        (task) =>
          task.groupId === groupId &&
          (task.id === taskId ||
            (taskId.length >= 8 && task.id.startsWith(taskId))),
      );
    return matches.length === 1 ? matches[0] : undefined;
  }
  private async acceptMessage(
    message: RepositoryCollaborationMessage,
  ): Promise<void> {
    if (
      !message.live ||
      !message.identityVerified ||
      message.automated ||
      !message.messageId ||
      !message.senderId ||
      !Number.isFinite(message.timestamp)
    )
      return;
    const command = parseCollaborationCommand(message.text);
    if (!command || message.text.length > MAX_PROMPT_LENGTH) return;
    const group = this.store.findGroup(message.connectionId, message.chatId);
    if (
      !group?.enabled ||
      group.activatedAt === null ||
      message.timestamp <= group.activatedAt ||
      message.timestamp > this.now() + 300000
    )
      return;
    const grants = this.store.allowedRepositoryIds(group.id, message.senderId);
    if (!grants.length || !(await this.isMember(group, message.senderId)))
      return;
    if (!this.started || !this.store.group(group.id)?.enabled) return;
    const currentGrants = this.store.allowedRepositoryIds(
      group.id,
      message.senderId,
    );
    if (grants.some((id) => !currentGrants.includes(id))) return;
    if (command.kind !== 'work') {
      const task = this.resolveTask(group.id, command.taskId);
      if (!task || !task.repositoryIds.every((id) => grants.includes(id)))
        return;
      if (!this.store.claimMessage(message)) return;
      if (command.kind === 'cancel') this.cancel(task);
      const status = this.store.task(task.id)!.status;
      this.output(
        group,
        message.senderId,
        `${reference(task)}: ${STATUS_LABELS[status]}.`,
        undefined,
      );
      return;
    }
    let parent = command.taskId
      ? this.resolveTask(group.id, command.taskId)
      : message.replyToMessageId
        ? this.store.taskFromReply(group.id, message.replyToMessageId)
        : undefined;
    if (command.taskId && !parent) {
      this.output(
        group,
        message.senderId,
        'No encuentro esa tarea en este grupo. / Task not found in this group.',
      );
      return;
    }
    if (parent) {
      if (!parent.repositoryIds.every((id) => grants.includes(id))) return;
      // Append to the latest turn: two humans can add requirements without racing a session.
      let child: RepositoryCollaborationTask | undefined;
      while (
        (child = this.store
          .tasks()
          .find((task) => task.parentTaskId === parent!.id))
      )
        parent = child;
      if (
        ['failed', 'cancelled', 'cancelling', 'needs_attention'].includes(
          parent.status,
        )
      ) {
        this.output(
          group,
          message.senderId,
          'La tarea requiere revisión en Forger antes de continuar. / Review this task in Forger before continuing.',
        );
        return;
      }
    }
    const repositories = this.store
      .repositories(group.id)
      .filter((repo) => grants.includes(repo.id));
    const selection = parent
      ? { repositoryIds: parent.repositoryIds, prompt: command.text }
      : selectRepositories(command.text, repositories);
    if (!selection) {
      this.output(
        group,
        message.senderId,
        'Indica el proyecto: “Forger, Proyecto: instrucción”. Para varios: “Forger, Proyecto + Otro: instrucción”. / Specify the project name before a colon.',
      );
      return;
    }
    if (selection.repositoryIds.length > 10) {
      this.output(
        group,
        message.senderId,
        'Selecciona hasta diez proyectos por tarea. / Select at most ten projects per task.',
      );
      return;
    }
    if (
      this.store
        .tasks()
        .filter((task) => task.groupId === group.id && task.status === 'queued')
        .length >= MAX_QUEUED_PER_GROUP
    ) {
      this.output(
        group,
        message.senderId,
        'La cola está llena. Espera a que terminen las tareas. / The queue is full; wait for current tasks to finish.',
      );
      return;
    }
    const task = this.store.createTaskForMessage(
      message,
      {
        groupId: group.id,
        participantId: message.senderId,
        participantName: message.senderName?.slice(0, 160) || message.senderId,
        sourceMessageId: message.messageId,
        ...selection,
        parentTaskId: parent?.id,
      },
      this.now(),
      (task) =>
        `${PREFIX} ${reference(task)} recibida y en cola. / Queued. Para añadir instrucciones: “Forger, ${reference(task)} …”.`,
    );
    if (!task) return;
    void this.flushOutbox();
    this.pump();
  }
  private pump(): void {
    if (!this.started) return;
    for (const task of this.store
      .tasks()
      .filter((task) => task.status === 'queued')) {
      if (this.active.has(task.id)) continue;
      if (!this.allowed(task)) {
        this.cancel(task);
        continue;
      }
      const parent = task.parentTaskId
        ? this.store.task(task.parentTaskId)
        : undefined;
      if (parent && parent.status !== 'completed') {
        if (
          ['failed', 'cancelled', 'cancelling', 'needs_attention'].includes(
            parent.status,
          )
        )
          this.store.updateTask(
            task.id,
            {
              status: 'needs_attention',
              result: 'La tarea anterior necesita revisión antes de continuar.',
            },
            this.now(),
          );
        continue;
      }
      const repositories = this.store
        .repositories(task.groupId)
        .filter((repo) => task.repositoryIds.includes(repo.id));
      if (
        repositories.some((repo) =>
          [...this.active.values()].some((running) =>
            running.roots.some((root) => rootsOverlap(root, repo.root)),
          ),
        )
      )
        continue;
      const controller = new AbortController();
      this.active.set(task.id, {
        controller,
        roots: repositories.map((repo) => repo.root),
      });
      const run = this.execute(task, repositories, controller);
      this.runs.add(run);
      void run.then(
        () => this.runs.delete(run),
        () => this.runs.delete(run),
      );
    }
  }
  private async execute(
    task: RepositoryCollaborationTask,
    repositories: LocalRepository[],
    controller: AbortController,
  ): Promise<void> {
    let membershipVerified = false;
    let waitForConnection = false;
    try {
      const group = this.requireGroup(task.groupId);
      if (!(await this.isMember(group, task.participantId))) {
        this.cancel(task);
        return;
      }
      membershipVerified = true;
      for (const repo of repositories) {
        if ((await validateRepositoryRoot(repo.root)) !== repo.root)
          throw new Error('repository changed');
      }
      if (!this.started || controller.signal.aborted || !this.allowed(task))
        return;
      this.store.updateTask(task.id, { status: 'running' }, this.now());
      this.output(
        group,
        task.participantId,
        `${reference(task)} comenzó. / Started.`,
        task,
      );
      const parent = task.parentTaskId
        ? this.store.task(task.parentTaskId)
        : undefined;
      const result = await this.executor.run({
        task: this.store.task(task.id)!,
        prompt: task.prompt,
        repositories,
        conversationId:
          parent?.conversationId ?? task.conversationId ?? undefined,
        signal: controller.signal,
      });
      if (
        controller.signal.aborted ||
        !this.started ||
        !this.allowed(task) ||
        this.store.task(task.id)?.status !== 'running'
      )
        return;
      if (!(await this.isMember(group, task.participantId))) {
        this.cancel(task);
        return;
      }
      if (
        !this.started ||
        controller.signal.aborted ||
        !this.allowed(task) ||
        this.store.task(task.id)?.status !== 'running'
      )
        return;
      const safeText = this.redactResult(result.text, repositories);
      this.store.completeTaskWithOutput(
        task.id,
        {
          status: 'completed',
          result: safeText,
          conversationId:
            result.conversationId ?? parent?.conversationId ?? null,
        },
        {
          groupId: group.id,
          participantId: task.participantId,
          taskId: task.id,
          text: `${PREFIX} ${reference(task)} terminada. / Completed.\n${safeText}`,
          replyToMessageId: task.sourceMessageId,
        },
        this.now(),
      );
      void this.flushOutbox();
    } catch (error) {
      if (
        !membershipVerified &&
        this.started &&
        !controller.signal.aborted &&
        this.store.task(task.id)?.status === 'queued'
      ) {
        // Startup and reconnect can precede WhatsApp roster availability. No work has begun.
        waitForConnection = true;
        return;
      }
      if (
        !controller.signal.aborted &&
        this.started &&
        !['cancelled', 'cancelling'].includes(
          this.store.task(task.id)?.status ?? '',
        )
      ) {
        this.store.updateTask(
          task.id,
          {
            status: 'failed',
            errorCode: this.executionErrorCode(error),
            result:
              'No se pudo completar la tarea. Revisa los cambios y la conexión en Forger antes de reintentar.',
          },
          this.now(),
        );
        const group = this.store.group(task.groupId);
        if (group)
          this.output(
            group,
            task.participantId,
            `${reference(task)} necesita revisión en Forger. / Review needed in Forger.`,
            task,
          );
      }
    } finally {
      if (this.store.task(task.id)?.status === 'cancelling')
        this.store.updateTask(task.id, { status: 'cancelled' }, this.now());
      this.active.delete(task.id);
      if (!waitForConnection) this.pump();
    }
  }
  private executionErrorCode(
    error: unknown,
  ): NonNullable<RepositoryCollaborationTask['errorCode']> {
    const code = error instanceof Error ? error.message : '';
    if (code === 'repository_execution_auth_required')
      return 'authentication_required';
    if (
      [
        'repository_execution_platform_unsupported',
        'repository_execution_runtime_missing',
        'repository_execution_runtime_unsupported',
      ].includes(code)
    )
      return 'runtime_unavailable';
    if (
      [
        'repository changed',
        'repository_execution_roots_invalid',
        'repository_execution_symlink_root',
        'repository_execution_git_metadata_external',
        'La carpeta seleccionada no es un repositorio Git disponible.',
      ].includes(code)
    )
      return 'repository_unavailable';
    return 'execution_failed';
  }
  private redactResult(text: string, repositories: LocalRepository[]): string {
    let result = text.slice(0, 40000);
    for (const repo of repositories)
      result = result.split(repo.root).join(`[${repo.name}]`);
    return result.replace(
      /(?:\/Users\/|\/home\/|[A-Za-z]:\\Users\\)[^\s\n`"<>]+/g,
      '[carpeta privada]',
    );
  }
  flushOutbox(): Promise<void> {
    if (!this.started) return Promise.resolve();
    if (this.outputFlush) return this.outputFlush;
    this.outputFlush = this.deliverOutbox().finally(() => {
      this.outputFlush = null;
    });
    return this.outputFlush;
  }
  private async deliverOutbox(): Promise<void> {
    const failedDestinations = new Set<string>();
    for (const output of this.store
      .outbox()
      .filter((output) => output.status === 'pending')) {
      if (!this.started) break;
      const group = this.store.group(output.groupId);
      const destination = group
        ? JSON.stringify([group.connectionId, group.chatId])
        : output.groupId;
      if (failedDestinations.has(destination)) continue;
      const task = output.taskId ? this.store.task(output.taskId) : undefined;
      if (
        !group?.enabled ||
        (task &&
          (!this.allowed(task) ||
            ['cancelled', 'cancelling'].includes(task.status))) ||
        !this.store.allowedRepositoryIds(output.groupId, output.participantId)
          .length
      ) {
        this.store.updateOutput(output.id, 'suppressed');
        continue;
      }
      try {
        const participants = await this.listParticipants(
          group.connectionId,
          group.chatId,
        );
        if (
          !participants.some(
            (person) => person.participantId === output.participantId,
          ) ||
          (task &&
            !participants.some(
              (person) => person.participantId === task.participantId,
            ))
        ) {
          this.store.updateOutput(output.id, 'suppressed');
          continue;
        }
        // Re-read after asynchronous roster lookup: an owner can revoke access while it is in flight.
        if (
          !this.store.group(group.id)?.enabled ||
          (task && !this.allowed(task))
        ) {
          this.store.updateOutput(output.id, 'suppressed');
          continue;
        }
        const everyoneAuthorized =
          !task ||
          participants
            .filter((person) => !person.isSelf)
            .every((person) => {
              const grants = this.store.allowedRepositoryIds(
                group.id,
                person.participantId,
              );
              return task.repositoryIds.every((id) => grants.includes(id));
            });
        const text = everyoneAuthorized
          ? output.text
          : `${PREFIX} ${task ? reference(task) : ''}: hay una actualización disponible para revisión local en Forger. / An update is available for local review in Forger.`;
        const response = await this.transport.sendMessage({
          connectionId: group.connectionId,
          chatId: group.chatId,
          text: text.slice(0, 3500),
          replyToMessageId: everyoneAuthorized
            ? (output.replyToMessageId ?? undefined)
            : undefined,
          canSend: async () => {
            if (
              !this.started ||
              this.store.outbox().find((item) => item.id === output.id)
                ?.status !== 'pending' ||
              !this.store.group(group.id)?.enabled ||
              (task && !this.allowed(task))
            )
              return false;
            const current = await this.listParticipants(
              group.connectionId,
              group.chatId,
            );
            if (
              !current.some(
                (person) => person.participantId === output.participantId,
              )
            )
              return false;
            if (
              task &&
              !current.some(
                (person) => person.participantId === task.participantId,
              )
            )
              return false;
            if (
              everyoneAuthorized &&
              task &&
              current
                .filter((person) => !person.isSelf)
                .some(
                  (person) =>
                    !task.repositoryIds.every((id) =>
                      this.store
                        .allowedRepositoryIds(group.id, person.participantId)
                        .includes(id),
                    ),
                )
            )
              return false;
            return (
              this.started &&
              !!this.store.group(group.id)?.enabled &&
              (!task || this.allowed(task)) &&
              this.store.outbox().find((item) => item.id === output.id)
                ?.status === 'pending'
            );
          },
        });
        this.store.updateOutput(output.id, 'sent', response.messageId);
      } catch {
        this.store.updateOutput(output.id, 'pending');
        // Preserve order within this chat while allowing other destinations to progress.
        failedDestinations.add(destination);
      }
    }
  }
}
