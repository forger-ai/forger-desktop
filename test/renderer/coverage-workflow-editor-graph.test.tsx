import { useState } from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { WorkflowDraft } from '@renderer/views/workflows/workflow-draft';
import { getDictionary } from '@renderer/i18n';
import { WorkflowEditor } from '@renderer/views/workflows/WorkflowEditor';

const flowSpy = vi.hoisted(() => ({ props: vi.fn() }));
const childSpies = vi.hoisted(() => ({ template: vi.fn(), schema: vi.fn(), mapping: vi.fn() }));

vi.mock('@xyflow/react', async () => {
  const React = await import('react');
  const applyChanges = (changes: Array<Record<string, any>>, nodes: Array<Record<string, any>>) => {
    let next = nodes;
    for (const change of changes) {
      if (change.type === 'remove') next = next.filter((node) => node.id !== change.id);
      if (change.type === 'position') next = next.map((node) => node.id === change.id
        ? { ...node, position: change.position }
        : node);
    }
    return next;
  };
  return {
    Position: { Left: 'left', Right: 'right' },
    Handle: ({ type, position }: Record<string, string>) => <span>{type}-{position}</span>,
    Background: () => <span>Flow background</span>,
    Controls: () => <span>Flow controls</span>,
    useNodesState: (initial: Array<Record<string, any>>) => {
      const [nodes, setNodes] = React.useState(initial);
      return [nodes, setNodes, (changes: Array<Record<string, any>>) => setNodes((current) => applyChanges(changes, current))];
    },
    ReactFlow: (props: Record<string, any>) => {
      flowSpy.props(props);
      return (
        <div data-testid="react-flow">
          {props.nodes.map((node: Record<string, any>) => {
            const Card = props.nodeTypes[node.type];
            return <div key={node.id} data-testid={`node-card-${node.id}`}><Card data={node.data} selected={node.selected} /></div>;
          })}
          <button onClick={() => props.onPaneClick()}>Flow pane</button>
          {props.nodes.map((node: Record<string, any>) => (
            <button key={`select-${node.id}`} onClick={(event) => props.onNodeClick(event, node)}>Select node {node.id}</button>
          ))}
          {props.edges.map((edge: Record<string, any>) => (
            <button key={`edge-${edge.id}`} onClick={(event) => props.onEdgeClick(event, edge)}>Select edge {edge.id}</button>
          ))}
          <button onClick={() => props.onConnect({ source: null, target: 'b' })}>Connect missing source</button>
          <button onClick={() => props.onConnect({ source: 'a', target: null })}>Connect missing target</button>
          <button onClick={() => props.onConnect({ source: 'a', target: 'a' })}>Connect self</button>
          <button onClick={() => props.onConnect({ source: 'a', target: 'b' })}>Connect a to b</button>
          <button onClick={() => props.onConnect({ source: 'b', target: 'c' })}>Connect b to c</button>
          <button onClick={() => props.onConnect({ source: 'a', target: 'c' })}>Connect a to c</button>
          <button onClick={() => props.onNodesChange([{ type: 'position', id: 'a', position: { x: 500, y: 600 } }])}>Move live node a</button>
          <button onClick={() => props.onNodesChange([{ type: 'remove', id: 'b' }])}>Drop live node b</button>
          <button onClick={() => props.onNodeDragStop()}>Finish drag</button>
          {props.children}
        </div>
      );
    },
  };
});

vi.mock('@renderer/views/workflows/TemplateEditor', () => ({
  TemplateEditor: (props: Record<string, any>) => {
    childSpies.template(props);
    return <button onClick={() => props.onChange('Updated {{ nodes.a.output }}')}>Change template</button>;
  },
}));

vi.mock('@renderer/views/workflows/SchemaForm', () => ({
  SchemaForm: (props: Record<string, any>) => {
    childSpies.schema(props);
    return <button onClick={() => props.onChange({ mapped: true })}>Change schema form</button>;
  },
  MappingMenuButton: (props: Record<string, any>) => {
    childSpies.mapping(props);
    return <button onClick={() => props.onPick('{{ nodes.a.output.items }}')}>Pick mapping</button>;
  },
}));

const t = getDictionary('en');
const conditionNode = (id: string, overrides: Record<string, unknown> = {}) => ({
  id, name: `Node ${id}`, type: 'condition' as const, position: { x: 10, y: 20 },
  expression: { left: '', operator: 'is_not_empty' as const }, ...overrides,
});
const draft = (overrides: Partial<WorkflowDraft> = {}): WorkflowDraft => ({
  name: 'Flow', description: '', trigger: { type: 'manual' }, nodes: [], edges: [], enabled: true, ...overrides,
});

const renderEditor = ({
  initialDraft = draft(),
  readOnly = false,
  nodeRuns,
  onOpenNodeRun,
  apps = [],
  agents = [],
  toolPackages = [],
  officialTools = [],
  connectionOptions = [],
  providerOptions = [],
  appActions = [],
  loadingAppActionAppIds = new Set<string>(),
  loadedAppActionAppIds = new Set<string>(),
  onRequestAppActions,
  outputSamples = {},
  savedNodeIds = new Set(['a']),
  includeRunNode = true,
}: {
  initialDraft?: WorkflowDraft;
  readOnly?: boolean;
  nodeRuns?: Record<string, any>;
  onOpenNodeRun?: (id: string) => void;
  apps?: any[];
  agents?: any[];
  toolPackages?: any[];
  officialTools?: any[];
  connectionOptions?: any[];
  providerOptions?: any[];
  appActions?: any[];
  loadingAppActionAppIds?: Set<string>;
  loadedAppActionAppIds?: Set<string>;
  onRequestAppActions?: (appId: string) => void;
  outputSamples?: Record<string, unknown>;
  savedNodeIds?: Set<string>;
  includeRunNode?: boolean;
} = {}) => {
  let currentDraft = initialDraft;
  const onRunNode = vi.fn();
  const Harness = () => {
    const [value, setValue] = useState(initialDraft);
    currentDraft = value;
    return (
      <>
        <WorkflowEditor
          draft={value}
          onDraftChange={(updater) => setValue((current) => updater(current))}
          apps={apps}
          agents={agents}
          toolPackages={toolPackages}
          officialTools={officialTools}
          connectionOptions={connectionOptions}
          providerOptions={providerOptions}
          appActions={appActions}
          loadingAppActionAppIds={loadingAppActionAppIds}
          loadedAppActionAppIds={loadedAppActionAppIds}
          onRequestAppActions={onRequestAppActions}
          outputSamples={outputSamples}
          savedNodeIds={savedNodeIds}
          onRunNode={includeRunNode ? onRunNode : undefined}
          readOnly={readOnly}
          nodeRuns={nodeRuns}
          onOpenNodeRun={onOpenNodeRun}
          t={t}
        />
        <output data-testid="draft-state">{JSON.stringify(value)}</output>
      </>
    );
  };
  const rendered = render(<Harness />);
  return { ...rendered, onRunNode, getDraft: () => currentDraft };
};

describe('WorkflowEditor graph', () => {
  it('adds every node type and auto-connects subsequent steps from the selected anchor', async () => {
    const user = userEvent.setup();
    const view = renderEditor();
    const labels = Object.values(t.sections.workflows.nodeTypes);
    for (const label of labels) await user.click(screen.getByRole('button', { name: label }));

    expect(view.getDraft().nodes.map((node) => node.type)).toEqual([
      'app_action',
      'llm_agent', 'forger_agent', 'forger_tool', 'connection', 'condition',
    ]);
    expect(view.getDraft().edges).toHaveLength(5);
    expect(view.getDraft().nodes[1]?.position).toEqual({ x: 320, y: 100 });
  });

  it('adds beside an unpositioned anchor without inventing an anchor offset', async () => {
    const user = userEvent.setup();
    const view = renderEditor({ initialDraft: draft({ nodes: [conditionNode('a', { position: undefined })] }) });
    await user.click(screen.getByRole('button', { name: 'Select node a' }));
    await user.click(screen.getByRole('button', { name: t.sections.workflows.nodeTypes.condition }));
    expect(view.getDraft().nodes[1]?.position).toEqual({ x: 340, y: 80 });
    expect(view.getDraft().edges).toEqual([{ from: 'a', to: 'paso2', condition: 'success' }]);
  });

  it('selects and deletes nodes and edges and changes an edge condition', async () => {
    const user = userEvent.setup();
    const view = renderEditor({ initialDraft: draft({
      nodes: [conditionNode('a'), conditionNode('b'), conditionNode('c')],
      edges: [
        { from: 'a', to: 'b', condition: 'success' },
        { from: 'b', to: 'a', condition: 'error' },
        { from: 'b', to: 'c', condition: 'success' },
      ],
    }) });
    expect(screen.getByText(t.sections.workflows.selectNode)).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Select edge a__b' }));
    expect(screen.getByText('a → b')).toBeVisible();
    await user.click(screen.getByLabelText(t.sections.workflows.edgeCondition));
    await user.click(screen.getByRole('option', { name: t.sections.workflows.edgeConditions.always }));
    expect(view.getDraft().edges[0]?.condition).toBe('always');
    await user.click(screen.getByRole('button', { name: t.sections.workflows.deleteEdge }));
    expect(view.getDraft().edges).toHaveLength(2);

    await user.click(screen.getByRole('button', { name: 'Select node a' }));
    await user.click(screen.getByRole('button', { name: t.sections.workflows.deleteNode }));
    expect(view.getDraft().nodes.map((node) => node.id)).toEqual(['b', 'c']);
    expect(view.getDraft().edges).toEqual([{ from: 'b', to: 'c', condition: 'success' }]);
    await user.click(screen.getByRole('button', { name: 'Flow pane' }));
    expect(screen.getByText(t.sections.workflows.selectNode)).toBeVisible();
  });

  it('adds a valid connection and clears a prior connection warning', async () => {
    const user = userEvent.setup();
    const view = renderEditor({ initialDraft: draft({ nodes: [conditionNode('a'), conditionNode('b')] }) });
    await user.click(screen.getByRole('button', { name: 'Connect a to b' }));
    expect(view.getDraft().edges).toEqual([{ from: 'a', to: 'b', condition: 'success' }]);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('rejects malformed, duplicate, self, readonly, and sibling-loop connections', async () => {
    const user = userEvent.setup();
    const base = draft({
      nodes: [
        conditionNode('root'),
        conditionNode('a', { forEach: 'nodes.root.output.items' }),
        conditionNode('b', { forEach: 'nodes.root.output.items' }),
        conditionNode('c'),
      ],
      edges: [
        { from: 'root', to: 'a', condition: 'success' },
        { from: 'root', to: 'b', condition: 'success' },
        { from: 'a', to: 'c', condition: 'success' },
      ],
    });
    const view = renderEditor({ initialDraft: base });
    for (const name of ['Connect missing source', 'Connect missing target', 'Connect self']) {
      await user.click(screen.getByRole('button', { name }));
    }
    expect(view.getDraft().edges).toHaveLength(3);
    await user.click(screen.getByRole('button', { name: 'Connect a to c' }));
    expect(view.getDraft().edges).toHaveLength(3);
    await user.click(screen.getByRole('button', { name: 'Connect b to c' }));
    expect(screen.getByRole('alert')).toHaveTextContent(t.sections.workflows.forEachJoinNotAllowed);
    expect(view.getDraft().edges).toHaveLength(3);
    await user.click(within(screen.getByRole('alert')).getByRole('button'));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    view.unmount();
    const locked = renderEditor({ initialDraft: base, readOnly: true });
    expect(screen.getByText(t.sections.workflows.lockedWhileRunning)).toBeVisible();
    expect(screen.queryByRole('button', { name: t.sections.workflows.nodeTypes.condition })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Connect b to c' }));
    expect(locked.getDraft().edges).toHaveLength(3);
  });

  it('persists live positions while preserving a draft node absent from the live graph', async () => {
    const user = userEvent.setup();
    const view = renderEditor({ initialDraft: draft({ nodes: [conditionNode('a'), conditionNode('b')] }) });
    await user.click(screen.getByRole('button', { name: 'Move live node a' }));
    await user.click(screen.getByRole('button', { name: 'Drop live node b' }));
    await user.click(screen.getByRole('button', { name: 'Finish drag' }));
    expect(view.getDraft().nodes[0]?.position).toEqual({ x: 500, y: 600 });
    expect(view.getDraft().nodes[1]?.position).toEqual({ x: 10, y: 20 });
  });

  it('projects every run status, active path, for-each count, and badge action', async () => {
    const onOpenNodeRun = vi.fn();
    const nodes = [
      conditionNode('a', { forEach: 'nodes.root.output.items' }),
      conditionNode('b'), conditionNode('c'), conditionNode('d'), conditionNode('e'), conditionNode('f', { forEach: 'bad ref' }),
    ];
    const nodeRuns = {
      a: { nodeId: 'a', status: 'running', output: { count: 3 } },
      b: { nodeId: 'b', status: 'succeeded', output: [] },
      c: { nodeId: 'c', status: 'failed', output: 'bad' },
      d: { nodeId: 'd', status: 'waiting_approval' },
      e: { nodeId: 'e', status: 'pending' },
      f: { nodeId: 'f', status: 'succeeded', output: { count: 'not-number' } },
    };
    renderEditor({
      initialDraft: draft({ nodes, edges: [
        { from: 'a', to: 'b', condition: 'always' },
        { from: 'b', to: 'c', condition: 'error' },
        { from: 'e', to: 'f', condition: 'success' },
      ] }),
      nodeRuns,
      onOpenNodeRun,
    });
    expect(screen.getByText('3')).toBeVisible();
    const card = screen.getByTestId('node-card-a');
    const badge = within(card).getByRole('button');
    fireEvent.click(badge);
    expect(onOpenNodeRun).toHaveBeenCalledWith('a');
    expect(flowSpy.props.mock.lastCall?.[0].edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'a__b', animated: true, style: expect.objectContaining({ strokeWidth: 3, opacity: 1 }) }),
      expect.objectContaining({ id: 'e__f', style: expect.objectContaining({ opacity: 0.35 }) }),
    ]));
  });

  it('renders run badges safely without an open callback and no projected run', async () => {
    const user = userEvent.setup();
    const view = renderEditor({
      initialDraft: draft({ nodes: [conditionNode('a')], edges: [] }),
      nodeRuns: { a: { nodeId: 'a', status: 'succeeded' } },
    });
    await user.click(within(screen.getByTestId('node-card-a')).getByRole('button'));
    view.unmount();
    renderEditor({ initialDraft: draft({ nodes: [conditionNode('a')] }) });
    expect(within(screen.getByTestId('node-card-a')).queryByRole('button')).not.toBeInTheDocument();
  });
});

describe('WorkflowEditor node panels', () => {
  it('edits an LLM agent runtime, apps, tools, mappings, schema, approval, timeout, and step run', async () => {
    const user = userEvent.setup();
    const source = conditionNode('a');
    const llm = {
      id: 'b', name: 'Writer', type: 'llm_agent' as const, position: { x: 250, y: 20 },
      prompt: 'Summarize', toolIds: ['mail.search'], appIds: ['unknown-app'], connectionGrants: [],
      runtime: { provider: 'codex' as const, model: 'gpt-5.2', effort: 'medium' as const },
      outputSchema: { type: 'object' }, requiresApproval: false, timeoutMs: 60_000,
      forEach: 'nodes.a.output.items',
    };
    const toolPackages = [
      { id: 'official:mail', name: 'Mail package', tools: [{ id: 'mail.search' }] },
      { id: 'custom:ignored', name: 'Ignored package', tools: [{ id: 'custom.tool' }] },
    ];
    const view = renderEditor({
      initialDraft: draft({ nodes: [source, llm], edges: [{ from: 'a', to: 'b', condition: 'success' }] }),
      apps: [{ id: 'notes', name: 'Notes' }, { id: 'calendar', name: 'Calendar' }],
      toolPackages,
      providerOptions: [
        { label: 'Automatic', value: 'auto' },
        { label: 'Claude account', value: 'claude' },
      ],
      outputSamples: { a: { items: [{ title: 'One' }] } },
      savedNodeIds: new Set(['b']),
    });
    await user.click(screen.getByRole('button', { name: 'Select node b' }));
    expect(screen.getAllByText(/Node a/).length).toBeGreaterThan(0);
    expect(childSpies.template.mock.lastCall?.[0].sources[0]).toMatchObject({ nodeId: '__item__', referenceBase: 'item' });

    await user.click(screen.getByRole('button', { name: 'Change template' }));
    expect((view.getDraft().nodes[1] as any).prompt).toContain('Updated');
    fireEvent.change(screen.getByLabelText(t.sections.workflows.nodeName), { target: { value: 'Writer two' } });
    expect(view.getDraft().nodes[1]?.name).toBe('Writer two');

    await user.click(screen.getByLabelText(t.sections.workflows.runtimeProvider));
    expect(screen.getByRole('option', { name: 'codex' })).toBeVisible();
    await user.click(screen.getByRole('option', { name: t.sections.workflows.autoProvider }));
    expect((view.getDraft().nodes[1] as any).runtime).toBeUndefined();
    await user.click(screen.getByLabelText(t.sections.workflows.runtimeProvider));
    await user.click(screen.getByRole('option', { name: 'Claude account' }));
    expect((view.getDraft().nodes[1] as any).runtime.provider).toBe('claude');

    await user.click(screen.getByLabelText(t.sections.workflows.runtimeModel));
    const modelOptions = screen.getAllByRole('option');
    await user.click(modelOptions.at(-1)!);
    await user.click(screen.getByLabelText(t.sections.workflows.runtimeEffort));
    await user.click(screen.getAllByRole('option').at(-1)!);

    const appsInput = screen.getByLabelText(t.sections.workflows.apps);
    await user.click(appsInput);
    await user.click(screen.getByRole('option', { name: 'Notes' }));
    expect((view.getDraft().nodes[1] as any).appIds).toContain('notes');
    const toolsInput = screen.getByLabelText(t.sections.workflows.toolsLabel);
    await user.click(toolsInput);
    await user.click(screen.getByRole('option', { name: 'Mail package' }));
    expect((view.getDraft().nodes[1] as any).toolIds).toEqual([]);
    await user.click(toolsInput);
    await user.click(screen.getByRole('option', { name: 'Mail package' }));
    expect((view.getDraft().nodes[1] as any).toolIds).toEqual(['mail.search']);

    const schema = screen.getByLabelText(t.sections.workflows.outputSchema);
    fireEvent.change(schema, { target: { value: '{broken' } });
    fireEvent.blur(schema);
    expect(screen.getByText(t.sections.workflows.outputSchemaInvalid)).toBeVisible();
    fireEvent.change(schema, { target: { value: '{"type":"string"}' } });
    fireEvent.blur(schema);
    expect((view.getDraft().nodes[1] as any).outputSchema).toEqual({ type: 'string' });
    fireEvent.change(schema, { target: { value: '   ' } });
    fireEvent.blur(schema);
    expect((view.getDraft().nodes[1] as any).outputSchema).toBeUndefined();

    await user.click(screen.getByRole('button', { name: 'Pick mapping' }));
    expect((view.getDraft().nodes[1] as any).forEach).toBe('nodes.a.output.items');
    const forEachInput = screen.getByLabelText(t.sections.workflows.forEachLabel);
    fireEvent.change(forEachInput, { target: { value: '  custom.items  ' } });
    expect((view.getDraft().nodes[1] as any).forEach).toBe('custom.items');
    fireEvent.change(forEachInput, { target: { value: ' ' } });
    expect((view.getDraft().nodes[1] as any).forEach).toBeUndefined();

    await user.click(screen.getByRole('checkbox', { name: t.sections.workflows.requiresApproval }));
    expect((view.getDraft().nodes[1] as any).requiresApproval).toBe(true);
    fireEvent.change(screen.getByLabelText(t.sections.workflows.timeout), { target: { value: '2' } });
    expect((view.getDraft().nodes[1] as any).timeoutMs).toBe(120_000);
    fireEvent.change(screen.getByLabelText(t.sections.workflows.timeout), { target: { value: '0' } });
    expect((view.getDraft().nodes[1] as any).timeoutMs).toBeUndefined();
    await user.click(screen.getByRole('button', { name: t.sections.workflows.testStep }));
    expect(view.onRunNode).toHaveBeenCalledWith('b');
  });

  it('uses automatic provider fallbacks and edits a Forger agent without upstream data or run controls', async () => {
    const user = userEvent.setup();
    const autoView = renderEditor({ initialDraft: draft({ nodes: [{
      id: 'llm', name: 'Auto', type: 'llm_agent', prompt: '', toolIds: [], appIds: [], connectionGrants: [],
    }] }), providerOptions: [], includeRunNode: false });
    await user.click(screen.getByRole('button', { name: 'Select node llm' }));
    expect(screen.getByLabelText(t.sections.workflows.runtimeProvider)).toHaveTextContent(t.sections.workflows.autoProvider);
    expect(screen.queryByText(t.sections.workflows.availableData)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: t.sections.workflows.testStep })).not.toBeInTheDocument();
    autoView.unmount();

    const agentView = renderEditor({
      initialDraft: draft({ nodes: [{ id: 'agent', name: 'Helper', type: 'forger_agent', agentId: '', prompt: '' }] }),
      agents: [{ id: 'agent-1', name: 'Researcher' }],
      savedNodeIds: new Set(),
    });
    await user.click(screen.getByRole('button', { name: 'Select node agent' }));
    await user.click(screen.getByLabelText(t.sections.workflows.agent));
    await user.click(screen.getByRole('option', { name: 'Researcher' }));
    expect((agentView.getDraft().nodes[0] as any).agentId).toBe('agent-1');
    expect(screen.getByRole('button', { name: t.sections.workflows.testStep })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Change template' }));
    expect((agentView.getDraft().nodes[0] as any).prompt).toContain('Updated');
  });

  it('switches a Forger tool between schema form and advanced JSON and reports configuration status', async () => {
    const user = userEvent.setup();
    const officialTools = [{
      id: 'mail', name: 'Mail', status: 'missing', actions: [{
        id: 'mail.send', name: 'Send', inputSchema: { type: 'object', properties: { to: { type: 'string' } } },
        outputSchema: { type: 'object', properties: { sent: { type: 'boolean' } } },
      }, { id: 'mail.ping', name: 'Ping' }],
    }];
    const view = renderEditor({
      initialDraft: draft({ nodes: [
        conditionNode('a'),
        { id: 'tool', name: 'Send mail', type: 'forger_tool', toolId: 'mail.send' as any, input: undefined },
      ], edges: [{ from: 'a', to: 'tool', condition: 'success' }] }),
      officialTools,
      outputSamples: { a: { email: 'a@example.com' } },
    });
    await user.click(screen.getByRole('button', { name: 'Select node tool' }));
    expect(screen.getAllByText(/Mail:/)).toHaveLength(2);
    expect(screen.getByRole('alert')).toHaveTextContent('Mail');
    expect(screen.getByRole('alert')).toHaveTextContent(t.sections.workflows.statusLabels.pending);
    await user.click(screen.getByRole('button', { name: 'Change schema form' }));
    expect((view.getDraft().nodes[1] as any).input).toEqual({ mapped: true });
    await user.click(screen.getByRole('button', { name: t.sections.workflows.advancedJson }));
    const input = screen.getByLabelText(t.sections.workflows.actionInput);
    fireEvent.change(input, { target: { value: '{bad' } });
    fireEvent.blur(input);
    expect(screen.getByText(t.sections.workflows.actionInputInvalid)).toBeVisible();
    expect(screen.getByRole('button', { name: t.sections.workflows.formMode })).toBeDisabled();
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);
    expect((view.getDraft().nodes[1] as any).input).toEqual({});
    await user.click(screen.getByRole('button', { name: t.sections.workflows.formMode }));
    await user.click(screen.getByLabelText(t.sections.workflows.forgerToolAction));
    await user.click(screen.getByRole('option', { name: 'Mail: Ping' }));
    expect((view.getDraft().nodes[1] as any).toolId).toBe('mail.ping');
  });

  it('filters connection accounts, labels every identity, changes actions and inputs, and flags stale grants', async () => {
    const user = userEvent.setup();
    const action = {
      id: 'mail.send', name: 'Send', inputSchema: { type: 'object', properties: { subject: { type: 'string' } } },
      outputSchema: { type: 'object', properties: { id: { type: 'string' } } },
    };
    const instances = [
      { id: 'email', status: 'connected', accountIdentity: { email: 'mail@example.com' } },
      { id: 'username', status: 'connected', accountIdentity: { username: 'mail-user' } },
      { id: 'workspace', status: 'connected', accountIdentity: { workspace: 'Workspace' } },
      { id: 'phone', status: 'connected', accountIdentity: { phoneNumber: '+123' } },
      { id: 'label', status: 'connected', label: 'Named account' },
      { id: 'fallback', status: 'connected' },
      { id: 'offline', status: 'disconnected', label: 'Offline' },
    ];
    const connectionOptions = [
      { type: 'mail', displayName: 'Mail', configured: true, instances, actions: [action, { id: 'mail.read', name: 'Read' }] },
      { type: 'calendar', displayName: 'Calendar', configured: true, instances: [{ id: 'only', status: 'connected', label: 'Only' }], actions: [action] },
      { type: 'empty', displayName: 'Empty', configured: false, instances: [], actions: [action] },
      { type: 'no-actions', displayName: 'No actions', configured: true, instances: [{ id: 'x', status: 'connected' }], actions: [] },
    ];
    const view = renderEditor({
      initialDraft: draft({ nodes: [conditionNode('a'), {
        id: 'connection', name: 'Mail action', type: 'connection', connectionType: 'mail', connectionId: 'missing',
        actionId: 'mail.send', input: undefined,
      }], edges: [{ from: 'a', to: 'connection', condition: 'success' }] }),
      connectionOptions,
      outputSamples: { a: { subject: 'Hello' } },
    });
    await user.click(screen.getByRole('button', { name: 'Select node connection' }));
    expect(screen.getByText(t.sections.workflows.connectionMissing)).toBeVisible();
    await user.click(screen.getByLabelText(t.sections.workflows.connectionAccount));
    for (const label of ['mail@example.com', 'mail-user', 'Workspace', '+123', 'Named account', 'fallback']) {
      expect(screen.getByRole('option', { name: label })).toBeVisible();
    }
    await user.click(screen.getByRole('option', { name: 'mail@example.com' }));
    expect((view.getDraft().nodes[1] as any).connectionId).toBe('email');
    await user.click(screen.getByLabelText(t.sections.workflows.connectionAccount));
    await user.click(screen.getByRole('option', { name: t.sections.workflows.connectionDefaultAccount }));
    expect((view.getDraft().nodes[1] as any).connectionId).toBeUndefined();

    await user.click(screen.getByRole('button', { name: 'Change schema form' }));
    expect((view.getDraft().nodes[1] as any).input).toEqual({ mapped: true });
    await user.click(screen.getByRole('button', { name: t.sections.workflows.advancedJson }));
    const input = screen.getByLabelText(t.sections.workflows.actionInput);
    fireEvent.change(input, { target: { value: '{bad' } });
    fireEvent.blur(input);
    expect(screen.getByText(t.sections.workflows.actionInputInvalid)).toBeVisible();
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);
    expect((view.getDraft().nodes[1] as any).input).toEqual({});
    fireEvent.change(input, { target: { value: '{"subject":"Hi"}' } });
    fireEvent.blur(input);
    expect((view.getDraft().nodes[1] as any).input).toEqual({ subject: 'Hi' });
    await user.click(screen.getByRole('button', { name: t.sections.workflows.formMode }));
    await user.click(screen.getByLabelText(t.sections.workflows.connectionAction));
    await user.click(screen.getByRole('option', { name: 'Read' }));
    expect((view.getDraft().nodes[1] as any).actionId).toBe('mail.read');

    await user.click(screen.getByLabelText(t.sections.workflows.connectionType));
    await user.click(screen.getByRole('option', { name: 'Calendar' }));
    expect(view.getDraft().nodes[1]).toMatchObject({ connectionType: 'calendar', connectionId: 'only', actionId: '' });
    expect(screen.getByLabelText(t.sections.workflows.connectionAccount)).toHaveValue('Only');
    await user.click(screen.getByLabelText(t.sections.workflows.connectionType));
    await user.click(screen.getByRole('option', { name: 'Mail' }));
    expect((view.getDraft().nodes[1] as any).connectionId).toBeUndefined();
  });

  it('shows stale connection types and raw actions without schemas or saved input', async () => {
    const user = userEvent.setup();
    const view = renderEditor({
      initialDraft: draft({ nodes: [{
        id: 'connection', name: 'Old connection', type: 'connection', connectionType: 'removed', actionId: '',
      }] }),
      connectionOptions: [{
        type: 'mail', displayName: 'Mail', configured: true,
        instances: [{ id: 'only', status: 'connected', label: 'Only' }],
        actions: [{ id: 'mail.ping', name: 'Ping' }],
      }],
    });
    await user.click(screen.getByRole('button', { name: 'Select node connection' }));
    expect(screen.getByLabelText(t.sections.workflows.connectionType)).toBeVisible();
    expect(screen.getByRole('alert')).toHaveTextContent(t.sections.workflows.connectionMissing);
    const input = screen.getByLabelText(t.sections.workflows.actionInput);
    expect(input).toHaveValue('{}');
    fireEvent.blur(input);
    expect((view.getDraft().nodes[0] as any).input).toEqual({});
  });

  it('omits tool warnings for configured and unknown actions and supports schema-less empty JSON', async () => {
    const user = userEvent.setup();
    const view = renderEditor({
      initialDraft: draft({ nodes: [{ id: 'tool', name: 'Ping', type: 'forger_tool', toolId: 'mail.ping' as any }] }),
      officialTools: [{ id: 'mail', name: 'Mail', status: 'configured', actions: [{ id: 'mail.ping', name: 'Ping' }] }],
    });
    await user.click(screen.getByRole('button', { name: 'Select node tool' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    const input = screen.getByLabelText(t.sections.workflows.actionInput);
    expect(input).toHaveValue('{}');
    fireEvent.blur(input);
    expect((view.getDraft().nodes[0] as any).input).toEqual({});
  });

  it('falls back safely for iterable references without a field path or matching origin', async () => {
    const user = userEvent.setup();
    const view = renderEditor({
      initialDraft: draft({ nodes: [
        conditionNode('a'),
        { id: 'agent', name: 'Loop agent', type: 'forger_agent', agentId: '', prompt: '', forEach: 'nodes.missing' },
      ], edges: [{ from: 'a', to: 'agent', condition: 'success' }] }),
      outputSamples: { a: 'whole output' },
    });
    await user.click(screen.getByRole('button', { name: 'Select node agent' }));
    expect(childSpies.template.mock.lastCall?.[0].sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ nodeId: '__item__', fields: [] }),
    ]));
    expect(screen.getByText(/^Node a \(\d+\)$/)).toBeVisible();
    view.unmount();

    renderEditor({
      initialDraft: draft({ nodes: [conditionNode('a'), {
        id: 'agent', name: 'Direct loop', type: 'forger_agent', agentId: '', prompt: '', forEach: 'nodes.a',
      }], edges: [{ from: 'a', to: 'agent', condition: 'success' }] }),
      outputSamples: { a: [{ value: 1 }] },
    });
    await user.click(screen.getByRole('button', { name: 'Select node agent' }));
    expect(childSpies.template.mock.lastCall?.[0].sources[0]).toMatchObject({ nodeId: '__item__' });
  });

  it('edits conditions with typed, mapped, empty, and value comparisons', async () => {
    const user = userEvent.setup();
    const view = renderEditor({
      initialDraft: draft({ nodes: [conditionNode('a'), conditionNode('condition', {
        expression: { left: '{{ nodes.a.output.value }}', operator: 'equals', right: 'yes' },
      })], edges: [{ from: 'a', to: 'condition', condition: 'success' }] }),
      outputSamples: { a: { value: 'yes' } },
    });
    await user.click(screen.getByRole('button', { name: 'Select node condition' }));
    fireEvent.change(screen.getByLabelText(t.sections.workflows.conditionLeft), { target: { value: 'left' } });
    fireEvent.change(screen.getByLabelText(t.sections.workflows.conditionRight), { target: { value: 'right' } });
    await user.click(screen.getByLabelText(t.sections.workflows.conditionOperator));
    await user.click(screen.getByRole('option', { name: t.sections.workflows.operators.is_empty }));
    expect(screen.queryByLabelText(t.sections.workflows.conditionRight)).not.toBeInTheDocument();
    await user.click(screen.getAllByRole('button', { name: 'Pick mapping' })[0]);
    expect((view.getDraft().nodes[1] as any).expression.left).toContain('nodes.a');
  });

  it('renders a blank right-hand condition value before it is entered', async () => {
    const user = userEvent.setup();
    renderEditor({ initialDraft: draft({ nodes: [conditionNode('condition', {
      expression: { left: '', operator: 'equals', right: undefined },
    })] }) });
    await user.click(screen.getByRole('button', { name: 'Select node condition' }));
    expect(screen.getByLabelText(t.sections.workflows.conditionRight)).toHaveValue('');
  });

  it('loads, selects, and edits app actions including stale contracts and mapped input', async () => {
    const user = userEvent.setup();
    const requestActions = vi.fn();
    const action = {
      toolName: 'notes.add', title: 'Add note', description: 'Creates a note',
      inputSchema: { type: 'object', properties: { title: { type: 'string' } } },
      outputSchema: { type: 'object' }, effect: 'write' as const, risk: 'high' as const,
      idempotent: false, contractHash: 'new-hash',
    };
    const staleAction = { ...action, title: 'Old action', contractHash: 'old-hash' };
    const view = renderEditor({
      initialDraft: draft({ nodes: [{
        id: 'app', name: 'Create note', type: 'app_action', appId: 'missing', toolName: 'missing.action',
        input: {}, action: staleAction,
      }] }),
      apps: [{ id: 'notes', name: 'Notes' }],
      appActions: [{ appId: 'notes', action }],
      loadedAppActionAppIds: new Set(['missing', 'notes']),
      onRequestAppActions: requestActions,
    });
    await user.click(screen.getByRole('button', { name: 'Select node app' }));
    expect(screen.getByText(t.sections.workflows.appActionAppMissing)).toBeVisible();
    expect(screen.getAllByRole('alert')[1]).toHaveTextContent(t.sections.workflows.appActionMissing);
    await user.click(screen.getByLabelText(t.sections.workflows.appActionApp));
    await user.click(screen.getByRole('option', { name: 'Notes' }));
    expect(requestActions).toHaveBeenCalledWith('notes');
    const actionSelect = screen.getByLabelText(t.sections.workflows.appActionAction);
    await user.click(actionSelect);
    await user.click(screen.getByRole('option', { name: 'Add note' }));
    expect(view.getDraft().nodes[0]).toMatchObject({ appId: 'notes', toolName: 'notes.add', input: {}, requiresApproval: true });
    expect(screen.getAllByText(t.sections.workflows.appActionApprovalRequired).length).toBeGreaterThan(0);
    await user.click(screen.getByRole('button', { name: 'Change schema form' }));
    expect(view.getDraft().nodes[0]).toMatchObject({ input: { mapped: true } });

    view.unmount();
    renderEditor({
      initialDraft: draft({ nodes: [{
        id: 'stale', name: 'Stale action', type: 'app_action', appId: 'notes', toolName: 'notes.add',
        input: {}, action: staleAction,
      }] }),
      apps: [{ id: 'notes', name: 'Notes' }],
      appActions: [{ appId: 'notes', action }],
      loadedAppActionAppIds: new Set(['notes']),
    });
    await user.click(screen.getByRole('button', { name: 'Select node stale' }));
    expect(screen.getAllByRole('alert').some((alert) => alert.textContent?.includes(t.sections.workflows.appActionContractChanged))).toBe(true);
  });

  it('covers loading and incomplete app-action metadata plus medium and low risks', async () => {
    const user = userEvent.setup();
    const baseAction = {
      toolName: 'notes.add', title: '',
      inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, effect: 'write' as const,
      idempotent: false, contractHash: 'hash',
    };
    renderEditor({
      initialDraft: draft({ nodes: [{
        id: 'fallback', name: 'Fallback action', type: 'app_action', appId: 'notes', toolName: 'notes.add',
        input: {}, action: baseAction, requiresApproval: false,
      }] }),
      apps: [{ id: 'notes', name: 'Notes' }],
      loadedAppActionAppIds: new Set(['notes']),
    });
    await user.click(screen.getByRole('button', { name: 'Select node fallback' }));
    expect(screen.getAllByRole('alert').some((alert) => alert.textContent?.includes(t.sections.workflows.appActionMissing))).toBe(true);
    expect(screen.getAllByText(t.sections.workflows.appActionApprovalRequired).length).toBeGreaterThan(0);

    cleanup();
    renderEditor({
      initialDraft: draft({ nodes: [{
        id: 'loading', name: 'Loading action', type: 'app_action', appId: 'notes', toolName: '',
        input: {}, action: baseAction,
      }] }),
      apps: [{ id: 'notes', name: 'Notes' }],
      loadingAppActionAppIds: new Set(['notes']),
    });
    await user.click(screen.getByRole('button', { name: 'Select node loading' }));
    expect(screen.getByText(t.sections.workflows.appActionLoading)).toBeVisible();

    const renderRisk = async (risk: 'medium' | 'low') => {
      cleanup();
      const action = { ...baseAction, title: `Risk ${risk}`, risk };
      renderEditor({
        initialDraft: draft({ nodes: [{
          id: `risk-${risk}`, name: `Risk ${risk}`, type: 'app_action', appId: 'notes', toolName: 'notes.add',
          input: {}, action,
        }] }),
        apps: [{ id: 'notes', name: 'Notes' }], appActions: [{ appId: 'notes', action }],
        loadedAppActionAppIds: new Set(['notes']),
      });
      await user.click(screen.getByRole('button', { name: `Select node risk-${risk}` }));
      expect(screen.getAllByText(`Risk ${risk}`).length).toBeGreaterThan(0);
    };
    await renderRisk('medium');
    await renderRisk('low');
  });
});
