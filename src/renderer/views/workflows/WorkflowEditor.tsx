import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  Checkbox,
  Chip,
  CircularProgress,
  Divider,
  FormControlLabel,
  IconButton,
  MenuItem,
  Paper,
  Stack,
  TextField,
  Tooltip,
  Typography,
  useTheme,
} from '@mui/material';
import AddRounded from '@mui/icons-material/AddRounded';
import DeleteOutlineRounded from '@mui/icons-material/DeleteOutlineRounded';
import PlayCircleOutlineRounded from '@mui/icons-material/PlayCircleOutlineRounded';
import CheckCircleRounded from '@mui/icons-material/CheckCircleRounded';
import CancelRounded from '@mui/icons-material/CancelRounded';
import PauseCircleRounded from '@mui/icons-material/PauseCircleRounded';
import RadioButtonUncheckedRounded from '@mui/icons-material/RadioButtonUncheckedRounded';
import {
  Background,
  Controls,
  ReactFlow,
  useNodesState,
  Handle,
  Position,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type {
  AgentEffort,
  AgentProvider,
  AgentToolPackageDefinition,
  AppSummary,
  OfficialToolSummary,
  PersonalAgent,
  PersonalAgentGrantOptionConnection,
  WorkflowConditionOperator,
  WorkflowAppActionContract,
  WorkflowAppActionCatalog,
  WorkflowAppActionSummary,
  WorkflowEdge,
  WorkflowEdgeCondition,
  WorkflowNode,
  WorkflowNodePosition,
  WorkflowNodeRun,
} from '@shared/types';
import { getRuntimeSupportedEfforts, LLM_PROVIDER_REGISTRY, normalizeRuntimeEffortForModel, type AgentProviderPreference } from '@shared/agent-runtime-registry';
import type { AppDictionary } from '@renderer/i18n';
import { buildUpstreamFieldSources, findForEachJoinConflict, parseReferencePath } from '@shared/workflow-templates';
import { resolveWorkflowNodePosition } from '@shared/workflow-node-positions';
import type { WorkflowDraft } from './workflow-draft';
import { createDraftNode, edgeKey } from './workflow-draft';
import { TemplateEditor, type TemplateSourceNode } from './TemplateEditor';
import { MappingMenuButton, SchemaForm } from './SchemaForm';
import { AppActionChangeDialog } from './AppActionChangeDialog';
import {
  appActionContractMatchesSummary,
  preserveCompatibleAppActionInput,
  summarizeAppActionContractChange,
  type PendingAppActionChange,
} from './app-action-editor';

const NODE_TYPE_COLORS: Record<WorkflowNode['type'], string> = {
  llm_agent: '#7c4dff',
  forger_agent: '#2e7d32',
  app_action: '#00695c',
  forger_tool: '#0288d1',
  connection: '#1565c0',
  condition: '#ed6c02',
};

const EDGE_COLORS: Record<WorkflowEdgeCondition, string> = {
  success: '#2e7d32',
  error: '#d32f2f',
  always: '#757575',
};

const CONDITION_OPERATORS: WorkflowConditionOperator[] = [
  'equals',
  'not_equals',
  'contains',
  'not_contains',
  'greater_than',
  'less_than',
  'is_empty',
  'is_not_empty',
];

const isConnectedConnectionInstance = (instance: PersonalAgentGrantOptionConnection['instances'][number]): boolean =>
  instance.status === 'connected';

const connectionInstanceLabel = (instance: PersonalAgentGrantOptionConnection['instances'][number]): string =>
  instance.accountIdentity?.email
  ?? instance.accountIdentity?.username
  ?? instance.accountIdentity?.workspace
  ?? instance.accountIdentity?.phoneNumber
  ?? instance.label
  ?? instance.id;

const hasSchemaProperties = (schema: Record<string, unknown> | undefined): boolean =>
  Boolean(schema?.properties
    && typeof schema.properties === 'object'
    && !Array.isArray(schema.properties)
    && Object.keys(schema.properties as Record<string, unknown>).length > 0);

export type ProviderOption = { label: string; value: AgentProviderPreference };
export type AppActionCatalogState = {
  status: 'idle' | 'loading' | 'ready' | 'error';
  catalog?: WorkflowAppActionCatalog;
  error?: string;
};

/** forEach nodes run once per item; surface the item count on the run badge. */
const forEachCountOf = (node: WorkflowNode, nodeRun: WorkflowNodeRun | undefined): number | undefined => {
  if (!node.forEach || !nodeRun) {
    return undefined;
  }
  const output = nodeRun.output;
  if (output && typeof output === 'object' && !Array.isArray(output) && typeof (output as { count?: unknown }).count === 'number') {
    return (output as { count: number }).count;
  }
  return undefined;
};

type FlowNodeData = {
  node: WorkflowNode;
  typeLabel: string;
  nodeRun?: WorkflowNodeRun;
  forEachCount?: number;
  onOpenRun?: (nodeId: string) => void;
};

const appActionCardLabel = (node: WorkflowNode): string | null => {
  if (node.type !== 'app_action') return null;
  const app = node.contract?.appName || node.appId;
  const action = node.contract?.actionTitle || node.toolName;
  return app && action ? `${app} · ${action}` : null;
};

/** Corner badge that reflects the status of this node in the selected run. */
const RunStatusBadge = ({ nodeRun, forEachCount, onOpenRun, nodeId }: {
  nodeRun: WorkflowNodeRun;
  forEachCount?: number;
  onOpenRun?: (nodeId: string) => void;
  nodeId: string;
}) => {
  const status = nodeRun.status;
  const icon = status === 'running'
    ? <CircularProgress size={18} thickness={5} />
    : status === 'succeeded'
      ? <CheckCircleRounded sx={{ fontSize: 20, color: 'success.main' }} />
      : status === 'failed'
        ? <CancelRounded sx={{ fontSize: 20, color: 'error.main' }} />
        : status === 'waiting_approval'
          ? <PauseCircleRounded sx={{ fontSize: 20, color: 'warning.main' }} />
          : <RadioButtonUncheckedRounded sx={{ fontSize: 20, color: 'text.disabled' }} />;
  return (
    <Box
      className="nodrag"
      sx={{
        position: 'absolute',
        top: -10,
        right: -10,
        display: 'flex',
        alignItems: 'center',
        gap: 0.25,
      }}
    >
      {typeof forEachCount === 'number' ? (
        <Chip size="small" label={forEachCount} sx={{ height: 18, '& .MuiChip-label': { px: 0.75, fontSize: 11 } }} />
      ) : null}
      <IconButton
        size="small"
        onClick={(event) => { event.stopPropagation(); onOpenRun?.(nodeId); }}
        sx={{ p: 0.25, bgcolor: 'background.paper', boxShadow: 1, '&:hover': { bgcolor: 'background.paper' } }}
      >
        {icon}
      </IconButton>
    </Box>
  );
};

const FlowNodeCard = ({ data, selected }: NodeProps) => {
  const { node, typeLabel, nodeRun, forEachCount, onOpenRun } = data as FlowNodeData;
  const color = NODE_TYPE_COLORS[node.type];
  return (
    <Box sx={{ position: 'relative' }}>
      <Paper
        variant="outlined"
        sx={{
          px: 1.5,
          py: 1,
          minWidth: 170,
          borderColor: selected ? color : undefined,
          borderWidth: selected ? 2 : 1,
          borderLeft: `5px solid ${color}`,
          borderRadius: 1.5,
          bgcolor: 'background.paper',
        }}
      >
        <Handle type="target" position={Position.Left} />
        <Typography variant="caption" sx={{ color, fontWeight: 700, display: 'block' }}>
          {typeLabel}
        </Typography>
        <Typography variant="body2" sx={{ fontWeight: 600 }}>{node.name}</Typography>
        {appActionCardLabel(node) ? (
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', maxWidth: 220 }} noWrap>
            {appActionCardLabel(node)}
          </Typography>
        ) : null}
        <Handle type="source" position={Position.Right} />
      </Paper>
      {nodeRun ? (
        <RunStatusBadge nodeRun={nodeRun} forEachCount={forEachCount} onOpenRun={onOpenRun} nodeId={node.id} />
      ) : null}
    </Box>
  );
};

const flowNodeTypes = { forgerNode: FlowNodeCard };

interface WorkflowEditorProps {
  draft: WorkflowDraft;
  onDraftChange: (updater: (current: WorkflowDraft) => WorkflowDraft) => void;
  apps: AppSummary[];
  agents: PersonalAgent[];
  toolPackages: AgentToolPackageDefinition[];
  officialTools: OfficialToolSummary[];
  connectionOptions: PersonalAgentGrantOptionConnection[];
  providerOptions: ProviderOption[];
  /** Latest known output per node id, from stored runs. */
  outputSamples: Record<string, unknown>;
  /** Node ids present in the saved workflow (test step needs a saved node). */
  savedNodeIds: ReadonlySet<string>;
  appActionCatalogs: Record<string, AppActionCatalogState>;
  loadAppActions: (appId: string, force?: boolean) => void;
  onRunNode?: (nodeId: string) => void;
  /** When true the graph can be panned and inspected but not edited (e.g. a run is in progress). */
  readOnly?: boolean;
  /** Node status for the run currently projected on the graph, keyed by node id. */
  nodeRuns?: Record<string, WorkflowNodeRun>;
  /** Opens the run detail modal for a node badge. */
  onOpenNodeRun?: (nodeId: string) => void;
  t: AppDictionary;
}

export function WorkflowEditor({ draft, onDraftChange, apps, agents, toolPackages, officialTools, connectionOptions, providerOptions, outputSamples, savedNodeIds, appActionCatalogs, loadAppActions, onRunNode, readOnly = false, nodeRuns, onOpenNodeRun, t }: WorkflowEditorProps) {
  const copy = t.sections.workflows;
  const theme = useTheme();
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeKey, setSelectedEdgeKey] = useState<string | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);

  // React Flow owns the live node positions during a drag; the draft owns the
  // node content (name, config, existence). We reconcile draft -> internal state
  // without stomping the dragged position, so moving a node stays smooth instead
  // of fighting the persisted value on every frame (the source of the blinking).
  const [rfNodes, setRfNodes, onNodesChange] = useNodesState<Node>([]);
  const rfNodesRef = useRef(rfNodes);
  rfNodesRef.current = rfNodes;
  const lastDraftPositionsRef = useRef(new Map<string, WorkflowNodePosition | undefined>());

  // Keep a stable identity for the badge callback so the reconcile effect below
  // does not re-run (and reset node state) on every parent render.
  const onOpenNodeRunRef = useRef(onOpenNodeRun);
  onOpenNodeRunRef.current = onOpenNodeRun;
  const openNodeRun = useCallback((nodeId: string) => onOpenNodeRunRef.current?.(nodeId), []);

  useLayoutEffect(() => {
    setRfNodes((previous) => {
      const previousById = new Map(previous.map((node) => [node.id, node]));
      const previousDraftPositions = lastDraftPositionsRef.current;
      const nextDraftPositions = new Map<string, WorkflowNodePosition | undefined>();
      const nodes = draft.nodes.map((node, index) => {
        const existing = previousById.get(node.id);
        nextDraftPositions.set(node.id, node.position ? { ...node.position } : undefined);
        const position = resolveWorkflowNodePosition({
          draftPosition: node.position,
          previousDraftPosition: previousDraftPositions.get(node.id),
          hadPreviousDraftPosition: previousDraftPositions.has(node.id),
          livePosition: existing?.position,
          fallbackPosition: { x: 80 + (index % 4) * 260, y: 80 + Math.floor(index / 4) * 160 },
        });
        const nodeRun = nodeRuns?.[node.id];
        return {
          id: node.id,
          type: 'forgerNode',
          position,
          draggable: !readOnly,
          selected: node.id === selectedNodeId,
          data: {
            node,
            typeLabel: copy.nodeTypes[node.type],
            nodeRun,
            forEachCount: forEachCountOf(node, nodeRun),
            onOpenRun: openNodeRun,
          } satisfies FlowNodeData,
        } as Node;
      });
      lastDraftPositionsRef.current = nextDraftPositions;
      return nodes;
    });
  }, [draft.nodes, selectedNodeId, readOnly, nodeRuns, copy.nodeTypes, openNodeRun, setRfNodes]);

  // Highlight the path a run actually flowed through; dim the branches it skipped.
  const activeEdgeKeys = useMemo(() => {
    if (!nodeRuns) {
      return new Set<string>();
    }
    const ran = (id: string) => {
      const status = nodeRuns[id]?.status;
      return status === 'succeeded' || status === 'failed' || status === 'running' || status === 'waiting_approval';
    };
    return new Set(draft.edges.filter((edge) => ran(edge.from) && ran(edge.to)).map(edgeKey));
  }, [nodeRuns, draft.edges]);

  const flowEdges: Edge[] = useMemo(() => draft.edges.map((edge) => {
    const active = activeEdgeKeys.has(edgeKey(edge));
    return {
      id: edgeKey(edge),
      source: edge.from,
      target: edge.to,
      label: copy.edgeConditions[edge.condition],
      animated: edge.condition === 'always' || active,
      selected: edgeKey(edge) === selectedEdgeKey,
      style: { stroke: EDGE_COLORS[edge.condition], strokeWidth: active ? 3 : 2, opacity: nodeRuns && !active ? 0.35 : 1 },
      labelStyle: { fill: EDGE_COLORS[edge.condition], fontSize: 11 },
      labelBgStyle: { fill: theme.palette.background.paper, fillOpacity: 0.95 },
      labelBgPadding: [6, 3] as [number, number],
      labelBgBorderRadius: 4,
    };
  }), [draft.edges, selectedEdgeKey, copy.edgeConditions, theme.palette.background.paper, activeEdgeKeys, nodeRuns]);

  const handleNodeDragStop = useCallback(() => {
    onDraftChange((current) => ({
      ...current,
      nodes: current.nodes.map((node) => {
        const rf = rfNodesRef.current.find((entry) => entry.id === node.id);
        return rf ? { ...node, position: { x: rf.position.x, y: rf.position.y } } : node;
      }),
    }));
  }, [onDraftChange]);

  const handleConnect = useCallback((connection: Connection) => {
    if (readOnly || !connection.source || !connection.target || connection.source === connection.target) {
      return;
    }
    onDraftChange((current) => {
      if (current.edges.some((edge) => edge.from === connection.source && edge.to === connection.target)) {
        return current;
      }
      const candidateEdges: WorkflowEdge[] = [
        ...current.edges,
        { from: connection.source as string, to: connection.target as string, condition: 'success' },
      ];
      // Joining two independent forEach loops is ambiguous; refuse the edge.
      if (findForEachJoinConflict(current.nodes, candidateEdges)) {
        setConnectError(copy.forEachJoinNotAllowed);
        return current;
      }
      setConnectError(null);
      return { ...current, edges: candidateEdges };
    });
  }, [onDraftChange, copy.forEachJoinNotAllowed]);

  const selectedNode = draft.nodes.find((node) => node.id === selectedNodeId) ?? null;
  const selectedEdge = draft.edges.find((edge) => edgeKey(edge) === selectedEdgeKey) ?? null;

  const actionOutputSchemas = useMemo(() => {
    const connectionOutputSchemas: Record<string, Record<string, unknown>> = {};
    const forgerToolOutputSchemas: Record<string, Record<string, unknown>> = {};
    for (const connection of connectionOptions) {
      for (const action of connection.actions) {
        if (action.outputSchema) {
          connectionOutputSchemas[action.id] = action.outputSchema;
        }
      }
    }
    for (const tool of officialTools) {
      for (const action of tool.actions) {
        if (action.outputSchema) {
          forgerToolOutputSchemas[action.id] = action.outputSchema;
        }
      }
    }
    return { connectionOutputSchemas, forgerToolOutputSchemas };
  }, [officialTools, connectionOptions]);

  const upstreamSources: TemplateSourceNode[] = useMemo(() => {
    if (!selectedNode) {
      return [];
    }
    return buildUpstreamFieldSources(draft, selectedNode.id, { outputSamples, ...actionOutputSchemas })
      .map((source) => ({
        nodeId: source.node.id,
        nodeName: source.node.name,
        fields: source.fields.map((field) => ({ path: field.path, sample: field.sample })),
      }));
  }, [draft, selectedNode, outputSamples, actionOutputSchemas]);

  const updateNode = (nodeId: string, updater: (node: WorkflowNode) => WorkflowNode) => {
    onDraftChange((current) => ({
      ...current,
      nodes: current.nodes.map((node) => (node.id === nodeId ? updater(node) : node)),
    }));
  };

  const addNode = (type: WorkflowNode['type']) => {
    onDraftChange((current) => {
      const anchor = selectedNodeId ? current.nodes.find((node) => node.id === selectedNodeId) : undefined;
      const node = createDraftNode(type, current.nodes, copy.nodeTypes[type]);
      if (anchor?.position) {
        node.position = { x: anchor.position.x + 240, y: anchor.position.y + 20 };
      }
      setSelectedNodeId(node.id);
      setSelectedEdgeKey(null);
      // Auto-connect from the selected step so new nodes join the flow instead of
      // stacking on top of each other on a fixed grid.
      const edges: WorkflowEdge[] = anchor
        ? [...current.edges, { from: anchor.id, to: node.id, condition: 'success' }]
        : current.edges;
      return { ...current, nodes: [...current.nodes, node], edges };
    });
  };

  const deleteSelectedNode = () => {
    if (!selectedNode) {
      return;
    }
    const nodeId = selectedNode.id;
    onDraftChange((current) => ({
      ...current,
      nodes: current.nodes.filter((node) => node.id !== nodeId),
      edges: current.edges.filter((edge) => edge.from !== nodeId && edge.to !== nodeId),
    }));
    setSelectedNodeId(null);
  };

  const deleteSelectedEdge = () => {
    if (!selectedEdge) {
      return;
    }
    const key = edgeKey(selectedEdge);
    onDraftChange((current) => ({
      ...current,
      edges: current.edges.filter((edge) => edgeKey(edge) !== key),
    }));
    setSelectedEdgeKey(null);
  };

  return (
    <Stack direction={{ xs: 'column', lg: 'row' }} spacing={1.5} sx={{ height: '100%', minHeight: 0 }}>
      <Paper variant="outlined" sx={{ flex: 1, minHeight: 0, borderRadius: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        {readOnly ? null : (
          <Stack
            direction="row"
            spacing={1}
            data-onboarding-target="workflow-add-step"
            sx={{ p: 1, borderBottom: 1, borderColor: 'divider', flexShrink: 0 }}
            flexWrap="wrap"
            useFlexGap
          >
            {(Object.keys(copy.nodeTypes) as Array<WorkflowNode['type']>).map((type) => (
              <Tooltip key={type} title={copy.nodeTypeTooltips[type]}>
                <span>
                  <Button
                    size="small"
                    variant="outlined"
                    data-onboarding-target={type === 'forger_tool' ? 'workflow-step-forger-tool' : type === 'connection' ? 'workflow-step-connection' : undefined}
                    startIcon={<AddRounded />}
                    sx={{ borderColor: NODE_TYPE_COLORS[type], color: NODE_TYPE_COLORS[type] }}
                    onClick={() => addNode(type)}
                  >
                    {copy.nodeTypes[type]}
                  </Button>
                </span>
              </Tooltip>
            ))}
          </Stack>
        )}
        {connectError ? (
          <Alert severity="warning" onClose={() => setConnectError(null)} sx={{ borderRadius: 0, flexShrink: 0 }}>
            {connectError}
          </Alert>
        ) : null}
        <Box
          sx={{
            flex: 1,
            minHeight: 0,
            '& .react-flow__controls': {
              boxShadow: theme.shadows[2],
              borderRadius: 1,
              overflow: 'hidden',
            },
            '& .react-flow__controls button': {
              backgroundColor: theme.palette.background.paper,
              color: theme.palette.text.primary,
              borderBottom: `1px solid ${theme.palette.divider}`,
            },
            '& .react-flow__controls button:hover': {
              backgroundColor: theme.palette.action.hover,
            },
            '& .react-flow__controls button svg': {
              fill: 'currentColor',
            },
            '& .react-flow__background': {
              backgroundColor: theme.palette.background.default,
            },
          }}
        >
          <ReactFlow
            nodes={rfNodes}
            edges={flowEdges}
            nodeTypes={flowNodeTypes}
            onNodesChange={onNodesChange}
            onNodeDragStop={handleNodeDragStop}
            onConnect={handleConnect}
            nodesDraggable={!readOnly}
            nodesConnectable={!readOnly}
            deleteKeyCode={null}
            onNodeClick={(_event, node) => {
              setSelectedNodeId(node.id);
              setSelectedEdgeKey(null);
            }}
            onEdgeClick={(_event, edge) => {
              setSelectedEdgeKey(edge.id);
              setSelectedNodeId(null);
            }}
            onPaneClick={() => {
              setSelectedNodeId(null);
              setSelectedEdgeKey(null);
            }}
            fitView
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={18} />
            <Controls showInteractive={false} />
          </ReactFlow>
        </Box>
      </Paper>
      <Paper variant="outlined" sx={{ width: { xs: '100%', lg: 380 }, p: 2, borderRadius: 1, minHeight: 0, overflow: 'auto', flexShrink: 0 }}>
        <Box sx={readOnly ? { pointerEvents: 'none', opacity: 0.75 } : undefined}>
          {selectedEdge ? (
            <EdgePanel
              edge={selectedEdge}
              copy={copy}
              onChangeCondition={(condition) => {
                const key = edgeKey(selectedEdge);
                onDraftChange((current) => ({
                  ...current,
                  edges: current.edges.map((edge) => (edgeKey(edge) === key ? { ...edge, condition } : edge)),
                }));
              }}
              onDelete={deleteSelectedEdge}
            />
          ) : selectedNode ? (
            <NodePanel
              node={selectedNode}
              copy={copy}
              apps={apps}
              agents={agents}
              toolPackages={toolPackages}
              officialTools={officialTools}
              connectionOptions={connectionOptions}
              providerOptions={providerOptions}
              appActionCatalogs={appActionCatalogs}
              loadAppActions={loadAppActions}
              sources={upstreamSources}
              canRunNode={savedNodeIds.has(selectedNode.id)}
              onRunNode={onRunNode}
              onChange={(updater) => updateNode(selectedNode.id, updater)}
              onDelete={deleteSelectedNode}
            />
          ) : (
            <Typography variant="body2" color="text.secondary">{readOnly ? copy.lockedWhileRunning : copy.selectNode}</Typography>
          )}
        </Box>
      </Paper>
    </Stack>
  );
}

type WorkflowCopy = AppDictionary['sections']['workflows'];

const EdgePanel = ({ edge, copy, onChangeCondition, onDelete }: {
  edge: WorkflowEdge;
  copy: WorkflowCopy;
  onChangeCondition: (condition: WorkflowEdgeCondition) => void;
  onDelete: () => void;
}) => (
  <Stack spacing={1.5}>
    <Typography variant="subtitle1" fontWeight={700}>{edge.from} → {edge.to}</Typography>
    <TextField
      select
      size="small"
      label={copy.edgeCondition}
      value={edge.condition}
      onChange={(event) => onChangeCondition(event.target.value as WorkflowEdgeCondition)}
    >
      {(['success', 'error', 'always'] as const).map((condition) => (
        <MenuItem key={condition} value={condition}>{copy.edgeConditions[condition]}</MenuItem>
      ))}
    </TextField>
    <Typography variant="caption" color="text.secondary">{copy.edgeConditionHelper}</Typography>
    <Button color="error" size="small" variant="outlined" startIcon={<DeleteOutlineRounded />} onClick={onDelete}>
      {copy.deleteEdge}
    </Button>
  </Stack>
);

const NodePanel = ({ node, copy, apps, agents, toolPackages, officialTools, connectionOptions, providerOptions, appActionCatalogs, loadAppActions, sources, canRunNode, onRunNode, onChange, onDelete }: {
  node: WorkflowNode;
  copy: WorkflowCopy;
  apps: AppSummary[];
  agents: PersonalAgent[];
  toolPackages: AgentToolPackageDefinition[];
  officialTools: OfficialToolSummary[];
  connectionOptions: PersonalAgentGrantOptionConnection[];
  providerOptions: ProviderOption[];
  appActionCatalogs: Record<string, AppActionCatalogState>;
  loadAppActions: (appId: string, force?: boolean) => void;
  sources: TemplateSourceNode[];
  canRunNode: boolean;
  onRunNode?: (nodeId: string) => void;
  onChange: (updater: (node: WorkflowNode) => WorkflowNode) => void;
  onDelete: () => void;
}) => {
  const [inputJsonError, setInputJsonError] = useState(false);
  const [schemaJsonError, setSchemaJsonError] = useState(false);
  const [rawActionInput, setRawActionInput] = useState(false);
  const [pendingAppAction, setPendingAppAction] = useState<PendingAppActionChange | null>(null);
  // With forEach active, every field of the node also offers the current item.
  const sourcesWithItem: TemplateSourceNode[] = (() => {
    if (!node.forEach) {
      return sources;
    }
    const listPath = node.forEach.replace(/^\{\{\s*/, '').replace(/\s*\}\}$/, '');
    const parts = parseReferencePath(listPath);
    if (!parts || parts.kind !== 'node' || !parts.nodeId) {
      return sources;
    }
    const origin = sources.find((source) => source.nodeId === parts.nodeId);
    const prefix = parts.fieldPath ? `${parts.fieldPath}.0.` : '0.';
    const itemFields = (origin?.fields ?? [])
      .filter((field) => field.path.startsWith(prefix))
      .map((field) => ({ path: field.path.slice(prefix.length), sample: field.sample }));
    return [
      { nodeId: '__item__', nodeName: copy.itemGroup, referenceBase: 'item', fields: itemFields },
      ...sources,
    ];
  })();
  // Tools are granted per official tool, not per action: selecting a tool
  // enables every action it exposes for this node.
  const officialPackages = useMemo(
    () => toolPackages.filter((toolPackage) => toolPackage.id.startsWith('official:')),
    [toolPackages],
  );
  const nodeToolIds = node.type === 'llm_agent' ? node.toolIds : [];
  const selectedPackageIds = useMemo(
    () => officialPackages
      .filter((toolPackage) => toolPackage.tools.some((tool) => nodeToolIds.includes(tool.id)))
      .map((toolPackage) => toolPackage.id),
    [officialPackages, nodeToolIds],
  );
  const nodeProvider = (node.type === 'llm_agent' ? node.runtime?.provider : undefined) ?? null;
  const visibleProviderOptions = useMemo(() => {
    const options = providerOptions.length > 0
      ? providerOptions
      : [{ label: copy.autoProvider, value: 'auto' as AgentProviderPreference }];
    if (nodeProvider && !options.some((option) => option.value === nodeProvider)) {
      return [...options, { label: nodeProvider, value: nodeProvider }];
    }
    return options;
  }, [providerOptions, nodeProvider, copy.autoProvider]);
  const forgerToolActions = useMemo(() => officialTools
    .flatMap((tool) => tool.actions.map((action) => ({ tool, action }))), [officialTools]);
  const connectedConnectionOptions = useMemo(() => connectionOptions
    .map((connection) => ({
      ...connection,
      instances: connection.instances.filter(isConnectedConnectionInstance),
    }))
    .filter((connection) => connection.instances.length > 0 && connection.actions.length > 0), [connectionOptions]);
  const connectionActions = useMemo(() => connectedConnectionOptions
    .flatMap((connection) => connection.actions.map((action) => ({
      connectionType: connection.type,
      connection,
      action,
    }))), [connectedConnectionOptions]);
  const connectionTypes = useMemo(() => connectedConnectionOptions.map((connection) => ({
    type: connection.type,
    label: connection.displayName,
    configured: connection.configured,
    instances: connection.instances,
  })), [connectedConnectionOptions]);
  const selectedConnectionOption = node.type === 'connection'
    ? connectedConnectionOptions.find((connection) => connection.type === node.connectionType)
    : undefined;
  const connectionTypeAvailable = node.type !== 'connection'
    || !node.connectionType
    || connectionTypes.some((connectionType) => connectionType.type === node.connectionType);
  const connectionIdAvailable = node.type !== 'connection'
    || !node.connectionId
    || Boolean(selectedConnectionOption?.instances.some((instance) => instance.id === node.connectionId));
  const installedApps = useMemo(
    () => apps.filter((app) => app.status === 'installed' || app.status === 'running'),
    [apps],
  );
  const appActionState = node.type === 'app_action' && node.appId
    ? appActionCatalogs[node.appId]
    : undefined;
  const appActionCatalog = appActionState?.catalog;
  const selectedCatalogAction = node.type === 'app_action'
    ? appActionCatalog?.actions.find((action) => action.toolName === node.toolName)
    : undefined;
  const appActionContract = node.type === 'app_action' ? node.contract : undefined;
  const appActionContractPending = node.type === 'app_action'
    && Boolean(node.toolName && !node.contract && selectedCatalogAction);
  const appActionContractChanged = node.type === 'app_action'
    && Boolean(node.contract && selectedCatalogAction
      && !appActionContractMatchesSummary(node.contract, selectedCatalogAction));
  const appActionEffect = appActionContract?.effect ?? selectedCatalogAction?.effect;
  const appActionRequiresApproval = appActionEffect === 'destructive'
    || appActionEffect === 'external'
    || appActionEffect === 'unknown';
  const selectedAppAvailable = node.type !== 'app_action'
    || !node.appId
    || installedApps.some((app) => app.id === node.appId);

  useEffect(() => {
    if (node.type === 'app_action' && node.appId && selectedAppAvailable && !appActionState) {
      loadAppActions(node.appId);
    }
  }, [node.type, node.type === 'app_action' ? node.appId : '', selectedAppAvailable, appActionState, loadAppActions]);

  useEffect(() => {
    if (node.type === 'app_action' && appActionRequiresApproval && node.requiresApproval !== true) {
      onChange((current) => current.type === 'app_action'
        ? { ...current, requiresApproval: true }
        : current);
    }
  }, [node.type, node.type === 'app_action' ? node.id : '', node.requiresApproval, appActionRequiresApproval, onChange]);

  const contractForAction = (action: WorkflowAppActionSummary): WorkflowAppActionContract => ({
    appName: appActionCatalog?.appName
      ?? (node.type === 'app_action' ? installedApps.find((app) => app.id === node.appId)?.name ?? node.appId : ''),
    ...(appActionCatalog?.appVersion ? { appVersion: appActionCatalog.appVersion } : {}),
    actionTitle: action.title,
    ...(action.description ? { description: action.description } : {}),
    inputSchema: action.inputSchema,
    outputSchema: action.outputSchema,
    annotations: action.annotations,
    effect: action.effect,
  });

  const hasConfiguredAppAction = node.type === 'app_action'
    && Boolean(node.toolName || Object.keys(node.input).length > 0 || node.contract);

  const applyAppActionApp = (appId: string): void => {
    if (appId) loadAppActions(appId);
    onChange((current) => {
      if (current.type !== 'app_action') return current;
      const { contract: _contract, ...rest } = current;
      return { ...rest, appId, toolName: '', input: {} };
    });
  };

  const applyAppActionSelection = (action: WorkflowAppActionSummary): void => {
    const contract = contractForAction(action);
    onChange((current) => current.type === 'app_action'
      ? {
          ...current,
          toolName: action.toolName,
          input: {},
          contract,
          requiresApproval: contract.effect !== 'read',
        }
      : current);
  };

  const adoptCurrentAppActionContract = (selectedCatalogAction: WorkflowAppActionSummary): void => {
    const contract = contractForAction(selectedCatalogAction);
    const nextInput = node.type === 'app_action'
      ? preserveCompatibleAppActionInput(node.input, contract.inputSchema)
      : {};
    onChange((current) => current.type === 'app_action'
      ? {
          ...current,
          contract,
          input: nextInput,
          requiresApproval: contract.effect !== 'read'
            ? true
            : current.requiresApproval,
        }
      : current);
  };

  const applyPendingAppAction = (): void => {
    if (!pendingAppAction) return;
    if (pendingAppAction.kind === 'app') applyAppActionApp(pendingAppAction.appId);
    else if (pendingAppAction.kind === 'action') applyAppActionSelection(pendingAppAction.action);
    else adoptCurrentAppActionContract(pendingAppAction.action);
    setPendingAppAction(null);
  };
  const pendingContractChange = node.type === 'app_action' && pendingAppAction?.kind === 'contract'
    ? summarizeAppActionContractChange(node.contract, pendingAppAction.action, node.input)
    : null;

  return (
    <Stack spacing={1.5}>
      <Stack direction="row" alignItems="center" justifyContent="space-between">
        <Tooltip title={copy.nodeTypeTooltips[node.type]}>
          <Typography variant="subtitle1" fontWeight={700}>{copy.nodeTypes[node.type]}</Typography>
        </Tooltip>
        <Button color="error" size="small" startIcon={<DeleteOutlineRounded />} onClick={onDelete}>
          {copy.deleteNode}
        </Button>
      </Stack>
      <TextField
        size="small"
        label={copy.nodeName}
        value={node.name}
        onChange={(event) => onChange((current) => ({ ...current, name: event.target.value }))}
      />

      {sources.length > 0 ? (
        <Box data-onboarding-target="workflow-input-mapping">
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
            {copy.availableData}
          </Typography>
          <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
            {sources.slice(0, 4).map((source) => (
              <Tooltip
                key={source.nodeId}
                title={source.fields.length > 0 ? source.fields.map((field) => field.path).join(', ') : copy.wholeOutput}
              >
                <Chip size="small" variant="outlined" label={`${source.nodeName} (${source.fields.length})`} />
              </Tooltip>
            ))}
          </Stack>
        </Box>
      ) : null}

      {node.type === 'llm_agent' || node.type === 'forger_agent' ? (
        <TemplateEditor
          label={copy.prompt}
          value={node.prompt}
          sources={sourcesWithItem}
          helperText={sources.length > 0 ? copy.referencePlaceholder : copy.promptHelper}
          placeholder={copy.referencePlaceholder}
          triggerGroupLabel={copy.triggerData}
          wholeOutputLabel={copy.wholeOutput}
          onChange={(nextPrompt) => onChange((current) => current.type === node.type
            ? { ...current, prompt: nextPrompt } as WorkflowNode
            : current)}
        />
      ) : null}

      {node.type === 'app_action' ? (
        <>
          <TextField
            select
            size="small"
            label={copy.appActionApp}
            value={node.appId}
            helperText={copy.appActionAppHelper}
            onChange={(event) => {
              const appId = event.target.value;
              if (appId === node.appId) return;
              if (hasConfiguredAppAction) setPendingAppAction({ kind: 'app', appId });
              else applyAppActionApp(appId);
            }}
          >
            {node.appId && !installedApps.some((app) => app.id === node.appId) ? (
              <MenuItem value={node.appId}>{node.contract?.appName ?? node.appId} · {copy.appActionUnavailable}</MenuItem>
            ) : null}
            {installedApps.map((app) => (
              <MenuItem key={app.id} value={app.id}>{app.name ?? app.id}</MenuItem>
            ))}
          </TextField>

          {!selectedAppAvailable ? (
            <Alert severity="warning" variant="outlined">{copy.appActionAppMissing}</Alert>
          ) : null}
          {selectedAppAvailable && node.appId && appActionState?.status === 'loading' ? (
            <Stack direction="row" spacing={1} alignItems="center">
              <CircularProgress size={16} />
              <Typography variant="body2" color="text.secondary">{copy.appActionLoading}</Typography>
            </Stack>
          ) : null}
          {selectedAppAvailable && node.appId && appActionState?.status === 'error' ? (
            <Alert
              severity="warning"
              variant="outlined"
              action={<Button size="small" color="inherit" onClick={() => loadAppActions(node.appId, true)}>{copy.retry}</Button>}
            >
              {copy.appActionLoadError}
            </Alert>
          ) : null}

          {node.appId && (appActionCatalog || node.contract) ? (
            <TextField
              select
              size="small"
              label={copy.appActionAction}
              value={node.toolName}
              helperText={copy.appActionActionHelper}
              onChange={(event) => {
                const toolName = event.target.value;
                if (toolName === node.toolName) return;
                const action = appActionCatalog?.actions.find((candidate) => candidate.toolName === toolName);
                if (!action) return;
                if (hasConfiguredAppAction) setPendingAppAction({ kind: 'action', action });
                else applyAppActionSelection(action);
              }}
            >
              {node.toolName && !appActionCatalog?.actions.some((action) => action.toolName === node.toolName) ? (
                <MenuItem value={node.toolName}>{node.contract?.actionTitle ?? node.toolName} · {copy.appActionUnavailable}</MenuItem>
              ) : null}
              {(appActionCatalog?.actions ?? []).map((action) => (
                <MenuItem key={action.toolName} value={action.toolName}>{action.title}</MenuItem>
              ))}
            </TextField>
          ) : null}

          {appActionState?.status === 'ready' && appActionCatalog?.actions.length === 0 ? (
            <Alert severity="info" variant="outlined">{copy.appActionEmpty}</Alert>
          ) : null}
          {appActionContractPending && selectedCatalogAction ? (
            <Alert
              severity="warning"
              variant="outlined"
              action={<Button size="small" color="inherit" onClick={() => setPendingAppAction({ kind: 'contract', action: selectedCatalogAction })}>{copy.appActionAdoptCurrentContract}</Button>}
            >
              {copy.appActionContractPending}
            </Alert>
          ) : null}
          {appActionContractChanged && selectedCatalogAction ? (
            <Alert
              severity="warning"
              variant="outlined"
              action={<Button size="small" color="inherit" onClick={() => setPendingAppAction({ kind: 'contract', action: selectedCatalogAction })}>{copy.appActionReviewCurrentContract}</Button>}
            >
              {copy.appActionContractChanged}
            </Alert>
          ) : null}
          {node.toolName && node.contract && !selectedCatalogAction
            && (!selectedAppAvailable || appActionState?.status === 'ready' || appActionState?.status === 'error') ? (
            <Alert severity="warning" variant="outlined">{copy.appActionSnapshot}</Alert>
          ) : null}
          {appActionContract ? (
            <Stack spacing={0.75}>
              <Stack direction="row" spacing={0.75} alignItems="center" flexWrap="wrap" useFlexGap>
                <Chip size="small" label={`${appActionContract.appName} · ${appActionContract.actionTitle}`} />
                <Chip size="small" variant="outlined" label={copy.appActionEffects[appActionContract.effect]} />
                {appActionContract.appVersion ? <Chip size="small" variant="outlined" label={`v${appActionContract.appVersion}`} /> : null}
              </Stack>
              {appActionContract.description ? (
                <Typography variant="caption" color="text.secondary">{appActionContract.description}</Typography>
              ) : null}
              {appActionRequiresApproval ? (
                <Alert severity="warning" variant="outlined">{copy.appActionApprovalRequired}</Alert>
              ) : null}
            </Stack>
          ) : null}

          {appActionContract ? (() => {
            const hasFormSchema = hasSchemaProperties(appActionContract.inputSchema);
            if (!rawActionInput && hasFormSchema) {
              return (
                <>
                  <SchemaForm
                    schema={appActionContract.inputSchema}
                    value={node.input ?? {}}
                    sources={sourcesWithItem}
                    mapTooltip={copy.mapField}
                    wholeOutputLabel={copy.wholeOutput}
                    triggerGroupLabel={copy.triggerData}
                    onChange={(nextInput) => onChange((current) => current.type === 'app_action'
                      ? { ...current, input: nextInput }
                      : current)}
                  />
                  <Button size="small" variant="text" sx={{ alignSelf: 'flex-start' }} onClick={() => setRawActionInput(true)}>
                    {copy.advancedJson}
                  </Button>
                </>
              );
            }
            return (
              <>
                <TextField
                  key={`${node.appId}:${node.toolName}:json-input`}
                  size="small"
                  label={copy.actionInput}
                  defaultValue={JSON.stringify(node.input ?? {}, null, 2)}
                  multiline
                  minRows={4}
                  error={inputJsonError}
                  helperText={inputJsonError ? copy.actionInputInvalid : copy.actionInputHelper}
                  onBlur={(event) => {
                    try {
                      const parsed = JSON.parse(event.target.value || '{}') as Record<string, unknown>;
                      setInputJsonError(false);
                      onChange((current) => current.type === 'app_action' ? { ...current, input: parsed } : current);
                    } catch {
                      setInputJsonError(true);
                    }
                  }}
                />
                {hasFormSchema ? (
                  <Button size="small" variant="text" sx={{ alignSelf: 'flex-start' }} disabled={inputJsonError} onClick={() => setRawActionInput(false)}>
                    {copy.formMode}
                  </Button>
                ) : null}
              </>
            );
          })() : null}
        </>
      ) : null}

      {node.type === 'forger_agent' ? (
        <TextField
          select
          size="small"
          label={copy.agent}
          value={node.agentId}
          onChange={(event) => onChange((current) => current.type === 'forger_agent'
            ? { ...current, agentId: event.target.value }
            : current)}
        >
          {agents.map((agent) => (
            <MenuItem key={agent.id} value={agent.id}>{agent.name}</MenuItem>
          ))}
        </TextField>
      ) : null}

      {node.type === 'llm_agent' ? (
        <>
          <TextField
            select
            size="small"
            label={copy.runtimeProvider}
            value={node.runtime?.provider ?? 'auto'}
            onChange={(event) => onChange((current) => {
              if (current.type !== 'llm_agent') {
                return current;
              }
              const provider = event.target.value;
              if (provider === 'auto') {
                const { runtime: _runtime, ...rest } = current;
                return rest as WorkflowNode;
              }
              const registry = LLM_PROVIDER_REGISTRY[provider as AgentProvider];
              return {
                ...current,
                runtime: {
                  provider: provider as AgentProvider,
                  model: registry.defaultModel,
                  effort: registry.defaultEffort,
                },
              };
            })}
          >
            {visibleProviderOptions.map((option) => (
              <MenuItem key={option.value} value={option.value}>
                {option.value === 'auto' ? copy.autoProvider : option.label}
              </MenuItem>
            ))}
          </TextField>
          {node.runtime ? (
            <Stack direction="row" spacing={1}>
              <TextField
                select
                size="small"
                fullWidth
                label={copy.runtimeModel}
                value={node.runtime.model}
                onChange={(event) => onChange((current) => {
                  if (current.type !== 'llm_agent' || !current.runtime) {
                    return current;
                  }
                  const model = event.target.value;
                  const effort = normalizeRuntimeEffortForModel(current.runtime.provider, model, current.runtime.effort);
                  return { ...current, runtime: { ...current.runtime, model, effort: effort as typeof current.runtime.effort } };
                })}
              >
                {LLM_PROVIDER_REGISTRY[node.runtime.provider].modelOptions.map((model) => (
                  <MenuItem key={model.realModelName} value={model.realModelName}>{model.displayModelName}</MenuItem>
                ))}
              </TextField>
              <TextField
                select
                size="small"
                sx={{ minWidth: 130 }}
                label={copy.runtimeEffort}
                value={normalizeRuntimeEffortForModel(node.runtime.provider, node.runtime.model, node.runtime.effort)}
                onChange={(event) => onChange((current) => current.type === 'llm_agent' && current.runtime
                  ? { ...current, runtime: { ...current.runtime, effort: event.target.value as typeof current.runtime.effort } }
                  : current)}
              >
                {LLM_PROVIDER_REGISTRY[node.runtime.provider].effortOptions
                  .filter((effort) => getRuntimeSupportedEfforts(node.runtime!.provider, node.runtime!.model).includes(effort.value as AgentEffort))
                  .map((effort) => (
                  <MenuItem key={effort.value} value={effort.value}>{effort.label}</MenuItem>
                ))}
              </TextField>
            </Stack>
          ) : null}
          <Autocomplete
            multiple
            size="small"
            options={apps.map((app) => app.id)}
            getOptionLabel={(appId) => apps.find((app) => app.id === appId)?.name ?? appId}
            value={node.appIds}
            onChange={(_event, value) => onChange((current) => current.type === 'llm_agent'
              ? { ...current, appIds: value }
              : current)}
            renderInput={(params) => (
              <TextField {...params} label={copy.apps} helperText={copy.appsHelper} />
            )}
          />
          <Autocomplete
            multiple
            size="small"
            options={officialPackages.map((toolPackage) => toolPackage.id)}
            getOptionLabel={(packageId) => officialPackages.find((toolPackage) => toolPackage.id === packageId)?.name ?? packageId}
            value={selectedPackageIds}
            onChange={(_event, value) => onChange((current) => current.type === 'llm_agent'
              ? {
                  ...current,
                  toolIds: officialPackages
                    .filter((toolPackage) => value.includes(toolPackage.id))
                    .flatMap((toolPackage) => toolPackage.tools.map((tool) => tool.id)),
                }
              : current)}
            renderInput={(params) => <TextField {...params} label={copy.toolsLabel} />}
          />
        </>
      ) : null}

      {node.type === 'llm_agent' || node.type === 'forger_agent' ? (
        <TextField
          size="small"
          label={copy.outputSchema}
          defaultValue={node.outputSchema ? JSON.stringify(node.outputSchema, null, 2) : ''}
          multiline
          minRows={2}
          error={schemaJsonError}
          helperText={schemaJsonError ? copy.outputSchemaInvalid : copy.outputSchemaHelper}
          onBlur={(event) => {
            const raw = event.target.value.trim();
            if (!raw) {
              setSchemaJsonError(false);
              onChange((current) => {
                if (current.type !== 'llm_agent' && current.type !== 'forger_agent') {
                  return current;
                }
                const { outputSchema: _schema, ...rest } = current;
                return rest as WorkflowNode;
              });
              return;
            }
            try {
              const parsed = JSON.parse(raw) as Record<string, unknown>;
              setSchemaJsonError(false);
              onChange((current) => current.type === 'llm_agent' || current.type === 'forger_agent'
                ? { ...current, outputSchema: parsed } as WorkflowNode
                : current);
            } catch {
              setSchemaJsonError(true);
            }
          }}
        />
      ) : null}

      {node.type === 'forger_tool' ? (
        <>
          <TextField
            select
            size="small"
            label={copy.forgerToolAction}
            value={node.toolId}
            onChange={(event) => onChange((current) => current.type === 'forger_tool'
              ? { ...current, toolId: event.target.value as typeof current.toolId }
              : current)}
          >
            {forgerToolActions.map(({ tool, action }) => (
              <MenuItem key={action.id} value={action.id}>{tool.name}: {action.name}</MenuItem>
            ))}
          </TextField>
          {(() => {
            const action = forgerToolActions.find((entry) => entry.action.id === node.toolId)?.action;
            const inputSchema = action?.inputSchema;
            const hasFormSchema = Boolean(inputSchema?.properties && Object.keys(inputSchema.properties as Record<string, unknown>).length > 0);
            if (!rawActionInput && hasFormSchema) {
              return (
                <>
                  <SchemaForm
                    schema={inputSchema as Record<string, unknown>}
                    value={node.input ?? {}}
                    sources={sourcesWithItem}
                    mapTooltip={copy.mapField}
                    wholeOutputLabel={copy.wholeOutput}
                    triggerGroupLabel={copy.triggerData}
                    onChange={(nextInput) => onChange((current) => current.type === 'forger_tool'
                      ? { ...current, input: nextInput }
                      : current)}
                  />
                  <Button size="small" variant="text" sx={{ alignSelf: 'flex-start' }} onClick={() => setRawActionInput(true)}>
                    {copy.advancedJson}
                  </Button>
                </>
              );
            }
            return (
              <>
                <TextField
                  size="small"
                  label={copy.actionInput}
                  defaultValue={JSON.stringify(node.input ?? {}, null, 2)}
                  multiline
                  minRows={4}
                  error={inputJsonError}
                  helperText={inputJsonError ? copy.actionInputInvalid : copy.actionInputHelper}
                  onBlur={(event) => {
                    try {
                      const parsed = JSON.parse(event.target.value || '{}') as Record<string, unknown>;
                      setInputJsonError(false);
                      onChange((current) => current.type === 'forger_tool' ? { ...current, input: parsed } : current);
                    } catch {
                      setInputJsonError(true);
                    }
                  }}
                />
                {hasFormSchema ? (
                  <Button
                    size="small"
                    variant="text"
                    sx={{ alignSelf: 'flex-start' }}
                    disabled={inputJsonError}
                    onClick={() => setRawActionInput(false)}
                  >
                    {copy.formMode}
                  </Button>
                ) : null}
              </>
            );
          })()}
        </>
      ) : null}

      {node.type === 'connection' ? (
        <>
          <TextField
            select
            size="small"
            label={copy.connectionType}
            value={connectionTypeAvailable ? node.connectionType : ''}
            onChange={(event) => onChange((current) => {
              if (current.type !== 'connection') {
                return current;
              }
              const connectionType = event.target.value;
              const option = connectedConnectionOptions.find((candidate) => candidate.type === connectionType);
              const defaultConnectionId = option?.instances.length === 1 ? option.instances[0]?.id : undefined;
              const { connectionId: _connectionId, ...rest } = current;
              return {
                ...rest,
                connectionType,
                actionId: '',
                ...(defaultConnectionId ? { connectionId: defaultConnectionId } : {}),
              };
            })}
          >
            {connectionTypes.map((connectionType) => (
              <MenuItem key={connectionType.type} value={connectionType.type}>
                {connectionType.label}
              </MenuItem>
            ))}
          </TextField>
          <TextField
            select
            size="small"
            label={copy.connectionAction}
            value={node.actionId}
            onChange={(event) => onChange((current) => current.type === 'connection'
              ? { ...current, actionId: event.target.value }
              : current)}
          >
            {connectionActions
              .filter((entry) => entry.connectionType === node.connectionType)
              .map(({ action }) => (
                <MenuItem key={action.id} value={action.id}>{action.name}</MenuItem>
              ))}
          </TextField>
          {selectedConnectionOption && selectedConnectionOption.instances.length > 1 ? (
            <TextField
              select
              size="small"
              label={copy.connectionAccount}
              value={connectionIdAvailable ? node.connectionId ?? '' : ''}
              helperText={copy.connectionIdHelper}
              onChange={(event) => onChange((current) => {
                if (current.type !== 'connection') {
                  return current;
                }
                const connectionId = event.target.value;
                if (!connectionId) {
                  const { connectionId: _connectionId, ...rest } = current;
                  return rest as WorkflowNode;
                }
                return { ...current, connectionId };
              })}
            >
              <MenuItem value="">{copy.connectionDefaultAccount}</MenuItem>
              {selectedConnectionOption.instances.map((instance) => (
                <MenuItem key={instance.id} value={instance.id}>{connectionInstanceLabel(instance)}</MenuItem>
              ))}
            </TextField>
          ) : selectedConnectionOption?.instances.length === 1 ? (
            <TextField
              size="small"
              label={copy.connectionAccount}
              value={connectionInstanceLabel(selectedConnectionOption.instances[0] as PersonalAgentGrantOptionConnection['instances'][number])}
              helperText={copy.connectionDefaultAccount}
              disabled
            />
          ) : null}
          {selectedConnectionOption && selectedConnectionOption.instances.length === 0 ? (
            <Alert severity="warning" variant="outlined">{copy.connectionMissing}</Alert>
          ) : null}
          {node.connectionType && (!connectionTypeAvailable || !selectedConnectionOption || !connectionIdAvailable) ? (
            <Alert severity="warning" variant="outlined">{copy.connectionMissing}</Alert>
          ) : null}
          {(() => {
            const action = connectionActions
              .find((entry) => entry.connectionType === node.connectionType && entry.action.id === node.actionId)?.action;
            const inputSchema = action?.inputSchema;
            const hasFormSchema = Boolean(inputSchema?.properties && Object.keys(inputSchema.properties as Record<string, unknown>).length > 0);
            if (!rawActionInput && hasFormSchema) {
              return (
                <>
                  <SchemaForm
                    schema={inputSchema as Record<string, unknown>}
                    value={node.input ?? {}}
                    sources={sourcesWithItem}
                    mapTooltip={copy.mapField}
                    wholeOutputLabel={copy.wholeOutput}
                    triggerGroupLabel={copy.triggerData}
                    onChange={(nextInput) => onChange((current) => current.type === 'connection'
                      ? { ...current, input: nextInput }
                      : current)}
                  />
                  <Button size="small" variant="text" sx={{ alignSelf: 'flex-start' }} onClick={() => setRawActionInput(true)}>
                    {copy.advancedJson}
                  </Button>
                </>
              );
            }
            return (
              <>
                <TextField
                  size="small"
                  label={copy.actionInput}
                  defaultValue={JSON.stringify(node.input ?? {}, null, 2)}
                  multiline
                  minRows={4}
                  error={inputJsonError}
                  helperText={inputJsonError ? copy.actionInputInvalid : copy.actionInputHelper}
                  onBlur={(event) => {
                    try {
                      const parsed = JSON.parse(event.target.value || '{}') as Record<string, unknown>;
                      setInputJsonError(false);
                      onChange((current) => current.type === 'connection' ? { ...current, input: parsed } : current);
                    } catch {
                      setInputJsonError(true);
                    }
                  }}
                />
                {hasFormSchema ? (
                  <Button
                    size="small"
                    variant="text"
                    sx={{ alignSelf: 'flex-start' }}
                    disabled={inputJsonError}
                    onClick={() => setRawActionInput(false)}
                  >
                    {copy.formMode}
                  </Button>
                ) : null}
              </>
            );
          })()}
        </>
      ) : null}

      {node.type === 'condition' ? (
        <>
          <TextField
            size="small"
            label={copy.conditionLeft}
            value={node.expression.left}
            helperText={copy.promptHelper}
            onChange={(event) => onChange((current) => current.type === 'condition'
              ? { ...current, expression: { ...current.expression, left: event.target.value } }
              : current)}
            slotProps={{
              input: {
                endAdornment: sourcesWithItem.length > 0 ? (
                  <MappingMenuButton
                    sources={sourcesWithItem}
                    tooltip={copy.mapField}
                    wholeOutputLabel={copy.wholeOutput}
                    triggerGroupLabel={copy.triggerData}
                    onPick={(reference) => onChange((current) => current.type === 'condition'
                      ? { ...current, expression: { ...current.expression, left: reference } }
                      : current)}
                  />
                ) : undefined,
              },
            }}
          />
          <TextField
            select
            size="small"
            label={copy.conditionOperator}
            value={node.expression.operator}
            onChange={(event) => onChange((current) => current.type === 'condition'
              ? { ...current, expression: { ...current.expression, operator: event.target.value as WorkflowConditionOperator } }
              : current)}
          >
            {CONDITION_OPERATORS.map((operator) => (
              <MenuItem key={operator} value={operator}>{copy.operators[operator]}</MenuItem>
            ))}
          </TextField>
          {node.expression.operator !== 'is_empty' && node.expression.operator !== 'is_not_empty' ? (
            <TextField
              size="small"
              label={copy.conditionRight}
              value={node.expression.right ?? ''}
              onChange={(event) => onChange((current) => current.type === 'condition'
                ? { ...current, expression: { ...current.expression, right: event.target.value } }
                : current)}
            />
          ) : null}
        </>
      ) : null}

      <Divider />
      {sources.length > 0 ? (
        <TextField
          size="small"
          label={copy.forEachLabel}
          value={node.forEach ?? ''}
          helperText={copy.forEachHelper}
          onChange={(event) => onChange((current) => {
            const raw = event.target.value.trim();
            if (!raw) {
              const { forEach: _forEach, ...rest } = current;
              return rest as WorkflowNode;
            }
            return { ...current, forEach: raw };
          })}
          slotProps={{
            input: {
              endAdornment: (
                <MappingMenuButton
                  sources={sources}
                  tooltip={copy.mapField}
                  wholeOutputLabel={copy.wholeOutput}
                  triggerGroupLabel={copy.triggerData}
                  onPick={(reference) => onChange((current) => ({
                    ...current,
                    forEach: reference.replace(/^\{\{\s*/, '').replace(/\s*\}\}$/, ''),
                  }))}
                />
              ),
            },
          }}
        />
      ) : null}
      <Box data-onboarding-target="workflow-approval">
        <FormControlLabel
          control={(
            <Checkbox
              size="small"
              checked={node.requiresApproval === true || appActionRequiresApproval}
              disabled={appActionRequiresApproval}
              onChange={(event) => onChange((current) => ({ ...current, requiresApproval: event.target.checked }))}
            />
          )}
          label={copy.requiresApproval}
        />
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>{copy.requiresApprovalHelper}</Typography>
      </Box>
      <TextField
        size="small"
        type="number"
        label={copy.timeout}
        value={node.timeoutMs ? Math.round(node.timeoutMs / 60_000) : ''}
        onChange={(event) => {
          const minutes = Number(event.target.value);
          onChange((current) => {
            if (!Number.isFinite(minutes) || minutes <= 0) {
              const { timeoutMs: _timeout, ...rest } = current;
              return rest as WorkflowNode;
            }
            return { ...current, timeoutMs: Math.round(minutes * 60_000) };
          });
        }}
      />
      {node.type === 'forger_tool' && node.toolId ? (() => {
        const selectedTool = forgerToolActions.find((entry) => entry.action.id === node.toolId)?.tool;
        return selectedTool && selectedTool.status !== 'configured' ? (
          <Alert severity="warning" variant="outlined">
            {selectedTool.name}: {copy.statusLabels.pending}
          </Alert>
        ) : null;
      })() : null}
      {onRunNode ? (
        <>
          <Divider />
          <Button
            size="small"
            variant="outlined"
            startIcon={<PlayCircleOutlineRounded />}
            disabled={!canRunNode}
            onClick={() => onRunNode(node.id)}
          >
            {copy.testStep}
          </Button>
          <Typography variant="caption" color="text.secondary">{copy.testStepHelper}</Typography>
        </>
      ) : null}
      <AppActionChangeDialog
        pending={pendingAppAction}
        contract={appActionContract}
        contractChanged={appActionContractChanged}
        contractChange={pendingContractChange}
        apps={installedApps}
        copy={copy}
        onCancel={() => setPendingAppAction(null)}
        onApply={applyPendingAppAction}
      />
    </Stack>
  );
};
