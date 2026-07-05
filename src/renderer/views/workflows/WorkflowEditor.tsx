import { useCallback, useMemo, useState } from 'react';
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  Checkbox,
  Chip,
  Divider,
  FormControlLabel,
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
import {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  type Connection,
  type Edge,
  type Node,
  type NodeChange,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type {
  AgentProvider,
  AgentToolPackageDefinition,
  AppSummary,
  OfficialToolSummary,
  PersonalAgent,
  WorkflowConditionOperator,
  WorkflowEdge,
  WorkflowEdgeCondition,
  WorkflowNode,
} from '@shared/types';
import { LLM_PROVIDER_REGISTRY, type AgentProviderPreference } from '@shared/agent-runtime-registry';
import type { AppDictionary } from '@renderer/i18n';
import { buildUpstreamFieldSources } from '@shared/workflow-templates';
import type { WorkflowDraft } from './workflow-draft';
import { createDraftNode, edgeKey } from './workflow-draft';
import { TemplateEditor, type TemplateSourceNode } from './TemplateEditor';
import { MappingMenuButton, SchemaForm } from './SchemaForm';

const NODE_TYPE_COLORS: Record<WorkflowNode['type'], string> = {
  llm_agent: '#7c4dff',
  forger_agent: '#2e7d32',
  connector: '#0288d1',
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

export type ProviderOption = { label: string; value: AgentProviderPreference };

const modelDefaultEffort = (provider: AgentProvider, realModelName: string): string | undefined => {
  const option = LLM_PROVIDER_REGISTRY[provider].modelOptions
    .find((model) => model.realModelName === realModelName) as
    | { defaultEffort?: string; defaultReasoningEffort?: string }
    | undefined;
  return option?.defaultEffort ?? option?.defaultReasoningEffort;
};

type FlowNodeData = { node: WorkflowNode; typeLabel: string };

const FlowNodeCard = ({ data, selected }: NodeProps) => {
  const { node, typeLabel } = data as FlowNodeData;
  const color = NODE_TYPE_COLORS[node.type];
  return (
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
      <Typography variant="caption" color="text.secondary">id: {node.id}</Typography>
      <Handle type="source" position={Position.Right} />
    </Paper>
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
  providerOptions: ProviderOption[];
  /** Latest known output per node id, from stored runs. */
  outputSamples: Record<string, unknown>;
  /** Node ids present in the saved workflow (test step needs a saved node). */
  savedNodeIds: ReadonlySet<string>;
  onRunNode?: (nodeId: string) => void;
  t: AppDictionary;
}

export function WorkflowEditor({ draft, onDraftChange, apps, agents, toolPackages, officialTools, providerOptions, outputSamples, savedNodeIds, onRunNode, t }: WorkflowEditorProps) {
  const copy = t.sections.workflows;
  const theme = useTheme();
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeKey, setSelectedEdgeKey] = useState<string | null>(null);

  const flowNodes: Node[] = useMemo(() => draft.nodes.map((node, index) => ({
    id: node.id,
    type: 'forgerNode',
    position: node.position ?? { x: 80 + (index % 4) * 260, y: 80 + Math.floor(index / 4) * 160 },
    data: { node, typeLabel: copy.nodeTypes[node.type] } satisfies FlowNodeData,
    selected: node.id === selectedNodeId,
  })), [draft.nodes, selectedNodeId, copy.nodeTypes]);

  const flowEdges: Edge[] = useMemo(() => draft.edges.map((edge) => ({
    id: edgeKey(edge),
    source: edge.from,
    target: edge.to,
    label: copy.edgeConditions[edge.condition],
    animated: edge.condition === 'always',
    selected: edgeKey(edge) === selectedEdgeKey,
    style: { stroke: EDGE_COLORS[edge.condition], strokeWidth: 2 },
    labelStyle: { fill: EDGE_COLORS[edge.condition], fontSize: 11 },
    labelBgStyle: { fill: theme.palette.background.paper, fillOpacity: 0.95 },
    labelBgPadding: [6, 3] as [number, number],
    labelBgBorderRadius: 4,
  })), [draft.edges, selectedEdgeKey, copy.edgeConditions, theme.palette.background.paper]);

  const handleNodesChange = useCallback((changes: NodeChange[]) => {
    const moved = changes.filter((change) => change.type === 'position' && change.position);
    if (moved.length === 0) {
      return;
    }
    onDraftChange((current) => ({
      ...current,
      nodes: current.nodes.map((node) => {
        const change = moved.find((entry) => entry.type === 'position' && entry.id === node.id);
        return change && change.type === 'position' && change.position
          ? { ...node, position: { x: change.position.x, y: change.position.y } }
          : node;
      }),
    }));
  }, [onDraftChange]);

  const handleConnect = useCallback((connection: Connection) => {
    if (!connection.source || !connection.target || connection.source === connection.target) {
      return;
    }
    onDraftChange((current) => {
      if (current.edges.some((edge) => edge.from === connection.source && edge.to === connection.target)) {
        return current;
      }
      return {
        ...current,
        edges: [...current.edges, { from: connection.source as string, to: connection.target as string, condition: 'success' }],
      };
    });
  }, [onDraftChange]);

  const selectedNode = draft.nodes.find((node) => node.id === selectedNodeId) ?? null;
  const selectedEdge = draft.edges.find((edge) => edgeKey(edge) === selectedEdgeKey) ?? null;

  const connectorOutputSchemas = useMemo(() => {
    const schemas: Record<string, Record<string, unknown>> = {};
    for (const tool of officialTools) {
      for (const action of tool.actions) {
        if (action.outputSchema) {
          schemas[action.id] = action.outputSchema;
        }
      }
    }
    return schemas;
  }, [officialTools]);

  const upstreamSources: TemplateSourceNode[] = useMemo(() => {
    if (!selectedNode) {
      return [];
    }
    return buildUpstreamFieldSources(draft, selectedNode.id, { outputSamples, connectorOutputSchemas })
      .map((source) => ({
        nodeId: source.node.id,
        nodeName: source.node.name,
        fields: source.fields.map((field) => ({ path: field.path, sample: field.sample })),
      }));
  }, [draft, selectedNode, outputSamples, connectorOutputSchemas]);

  const updateNode = (nodeId: string, updater: (node: WorkflowNode) => WorkflowNode) => {
    onDraftChange((current) => ({
      ...current,
      nodes: current.nodes.map((node) => (node.id === nodeId ? updater(node) : node)),
    }));
  };

  const addNode = (type: WorkflowNode['type']) => {
    onDraftChange((current) => {
      const node = createDraftNode(type, current.nodes, copy.nodeTypes[type]);
      setSelectedNodeId(node.id);
      setSelectedEdgeKey(null);
      return { ...current, nodes: [...current.nodes, node] };
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
    <Stack direction={{ xs: 'column', lg: 'row' }} spacing={1.5} sx={{ minHeight: 480 }}>
      <Paper variant="outlined" sx={{ flex: 1, minHeight: 480, borderRadius: 1, overflow: 'hidden' }}>
        <Stack direction="row" spacing={1} sx={{ p: 1, borderBottom: 1, borderColor: 'divider' }} flexWrap="wrap" useFlexGap>
          {(Object.keys(copy.nodeTypes) as Array<WorkflowNode['type']>).map((type) => (
            <Button
              key={type}
              size="small"
              variant="outlined"
              startIcon={<AddRounded />}
              sx={{ borderColor: NODE_TYPE_COLORS[type], color: NODE_TYPE_COLORS[type] }}
              onClick={() => addNode(type)}
            >
              {copy.nodeTypes[type]}
            </Button>
          ))}
        </Stack>
        <Box
          sx={{
            height: 460,
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
            nodes={flowNodes}
            edges={flowEdges}
            nodeTypes={flowNodeTypes}
            onNodesChange={handleNodesChange}
            onConnect={handleConnect}
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
      <Paper variant="outlined" sx={{ width: { xs: '100%', lg: 380 }, p: 2, borderRadius: 1, maxHeight: 560, overflow: 'auto' }}>
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
            providerOptions={providerOptions}
            sources={upstreamSources}
            canRunNode={savedNodeIds.has(selectedNode.id)}
            onRunNode={onRunNode}
            onChange={(updater) => updateNode(selectedNode.id, updater)}
            onDelete={deleteSelectedNode}
          />
        ) : (
          <Typography variant="body2" color="text.secondary">{copy.selectNode}</Typography>
        )}
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

const NodePanel = ({ node, copy, apps, agents, toolPackages, officialTools, providerOptions, sources, canRunNode, onRunNode, onChange, onDelete }: {
  node: WorkflowNode;
  copy: WorkflowCopy;
  apps: AppSummary[];
  agents: PersonalAgent[];
  toolPackages: AgentToolPackageDefinition[];
  officialTools: OfficialToolSummary[];
  providerOptions: ProviderOption[];
  sources: TemplateSourceNode[];
  canRunNode: boolean;
  onRunNode?: (nodeId: string) => void;
  onChange: (updater: (node: WorkflowNode) => WorkflowNode) => void;
  onDelete: () => void;
}) => {
  const [inputJsonError, setInputJsonError] = useState(false);
  const [schemaJsonError, setSchemaJsonError] = useState(false);
  const [rawConnectorInput, setRawConnectorInput] = useState(false);
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

  return (
    <Stack spacing={1.5}>
      <Stack direction="row" alignItems="center" justifyContent="space-between">
        <Typography variant="subtitle1" fontWeight={700}>{copy.nodeTypes[node.type]}</Typography>
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
        <Box>
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
          sources={sources}
          helperText={sources.length > 0 ? copy.referencePlaceholder : copy.promptHelper}
          placeholder={copy.referencePlaceholder}
          triggerGroupLabel={copy.triggerData}
          wholeOutputLabel={copy.wholeOutput}
          onChange={(nextPrompt) => onChange((current) => current.type === node.type
            ? { ...current, prompt: nextPrompt } as WorkflowNode
            : current)}
        />
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
                  const effort = modelDefaultEffort(current.runtime.provider, model) ?? current.runtime.effort;
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
                value={node.runtime.effort}
                onChange={(event) => onChange((current) => current.type === 'llm_agent' && current.runtime
                  ? { ...current, runtime: { ...current.runtime, effort: event.target.value as typeof current.runtime.effort } }
                  : current)}
              >
                {LLM_PROVIDER_REGISTRY[node.runtime.provider].effortOptions.map((effort) => (
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

      {node.type === 'connector' ? (
        <>
          <TextField
            select
            size="small"
            label={copy.connectorTool}
            value={node.toolId}
            onChange={(event) => onChange((current) => current.type === 'connector'
              ? { ...current, toolId: event.target.value, actionId: '' }
              : current)}
          >
            {officialTools.map((tool) => (
              <MenuItem key={tool.id} value={tool.id}>{tool.name}</MenuItem>
            ))}
          </TextField>
          <TextField
            select
            size="small"
            label={copy.connectorAction}
            value={node.actionId}
            onChange={(event) => onChange((current) => current.type === 'connector'
              ? { ...current, actionId: event.target.value }
              : current)}
          >
            {(officialTools.find((tool) => tool.id === node.toolId)?.actions ?? []).map((action) => (
              <MenuItem key={action.id} value={action.id}>{action.name}</MenuItem>
            ))}
          </TextField>
          {(() => {
            const action = officialTools
              .find((tool) => tool.id === node.toolId)?.actions
              .find((entry) => entry.id === node.actionId);
            const inputSchema = action?.inputSchema;
            const hasFormSchema = Boolean(inputSchema?.properties && Object.keys(inputSchema.properties as Record<string, unknown>).length > 0);
            if (!rawConnectorInput && hasFormSchema) {
              return (
                <>
                  <SchemaForm
                    schema={inputSchema as Record<string, unknown>}
                    value={node.input ?? {}}
                    sources={sources}
                    mapTooltip={copy.mapField}
                    wholeOutputLabel={copy.wholeOutput}
                    triggerGroupLabel={copy.triggerData}
                    onChange={(nextInput) => onChange((current) => current.type === 'connector'
                      ? { ...current, input: nextInput }
                      : current)}
                  />
                  <Button size="small" variant="text" sx={{ alignSelf: 'flex-start' }} onClick={() => setRawConnectorInput(true)}>
                    {copy.advancedJson}
                  </Button>
                </>
              );
            }
            return (
              <>
                <TextField
                  size="small"
                  label={copy.connectorInput}
                  defaultValue={JSON.stringify(node.input ?? {}, null, 2)}
                  multiline
                  minRows={4}
                  error={inputJsonError}
                  helperText={inputJsonError ? copy.connectorInputInvalid : copy.connectorInputHelper}
                  onBlur={(event) => {
                    try {
                      const parsed = JSON.parse(event.target.value || '{}') as Record<string, unknown>;
                      setInputJsonError(false);
                      onChange((current) => current.type === 'connector' ? { ...current, input: parsed } : current);
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
                    onClick={() => setRawConnectorInput(false)}
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
                endAdornment: sources.length > 0 ? (
                  <MappingMenuButton
                    sources={sources}
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
      <FormControlLabel
        control={(
          <Checkbox
            size="small"
            checked={node.requiresApproval === true}
            onChange={(event) => onChange((current) => ({ ...current, requiresApproval: event.target.checked }))}
          />
        )}
        label={copy.requiresApproval}
      />
      <Typography variant="caption" color="text.secondary">{copy.requiresApprovalHelper}</Typography>
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
      {node.type === 'connector' && officialTools.find((tool) => tool.id === node.toolId)?.status !== 'configured' && node.toolId ? (
        <Alert severity="warning" variant="outlined">
          {officialTools.find((tool) => tool.id === node.toolId)?.name}: {copy.statusLabels.pending}
        </Alert>
      ) : null}
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
    </Stack>
  );
};
