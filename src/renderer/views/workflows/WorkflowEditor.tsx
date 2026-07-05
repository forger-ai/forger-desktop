import { useCallback, useMemo, useState } from 'react';
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  Checkbox,
  Divider,
  FormControlLabel,
  MenuItem,
  Paper,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import AddRounded from '@mui/icons-material/AddRounded';
import DeleteOutlineRounded from '@mui/icons-material/DeleteOutlineRounded';
import {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  applyNodeChanges,
  type Connection,
  type Edge,
  type Node,
  type NodeChange,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type {
  AgentToolPackageDefinition,
  AppSummary,
  OfficialToolSummary,
  PersonalAgent,
  WorkflowConditionOperator,
  WorkflowEdge,
  WorkflowEdgeCondition,
  WorkflowNode,
} from '@shared/types';
import type { AppDictionary } from '@renderer/i18n';
import type { WorkflowDraft } from './workflow-draft';
import { createDraftNode, edgeKey } from './workflow-draft';

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

const PROVIDER_OPTIONS = ['auto', 'codex', 'claude', 'antigravity'] as const;
const EFFORT_OPTIONS = ['low', 'medium', 'high'] as const;

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
  t: AppDictionary;
}

export function WorkflowEditor({ draft, onDraftChange, apps, agents, toolPackages, officialTools, t }: WorkflowEditorProps) {
  const copy = t.sections.workflows;
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
  })), [draft.edges, selectedEdgeKey, copy.edgeConditions]);

  const handleNodesChange = useCallback((changes: NodeChange[]) => {
    const moved = changes.filter((change) => change.type === 'position' && change.position);
    if (moved.length === 0) {
      // Let selection changes flow through React Flow's own state.
      applyNodeChanges(changes, flowNodes);
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
  }, [flowNodes, onDraftChange]);

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
        <Box sx={{ height: 460 }}>
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

const NodePanel = ({ node, copy, apps, agents, toolPackages, officialTools, onChange, onDelete }: {
  node: WorkflowNode;
  copy: WorkflowCopy;
  apps: AppSummary[];
  agents: PersonalAgent[];
  toolPackages: AgentToolPackageDefinition[];
  officialTools: OfficialToolSummary[];
  onChange: (updater: (node: WorkflowNode) => WorkflowNode) => void;
  onDelete: () => void;
}) => {
  const [inputJsonError, setInputJsonError] = useState(false);
  const [schemaJsonError, setSchemaJsonError] = useState(false);
  const toolOptions = useMemo(
    () => toolPackages.flatMap((toolPackage) => toolPackage.tools.map((tool) => ({ id: tool.id, label: `${tool.name} (${tool.id})` }))),
    [toolPackages],
  );

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

      {node.type === 'llm_agent' || node.type === 'forger_agent' ? (
        <TextField
          size="small"
          label={copy.prompt}
          value={node.prompt}
          multiline
          minRows={4}
          helperText={copy.promptHelper}
          onChange={(event) => onChange((current) => current.type === node.type
            ? { ...current, prompt: event.target.value } as WorkflowNode
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
              return {
                ...current,
                runtime: {
                  provider: provider as 'codex' | 'claude' | 'antigravity',
                  model: current.runtime?.model ?? '',
                  effort: current.runtime?.effort ?? 'medium',
                },
              };
            })}
          >
            {PROVIDER_OPTIONS.map((provider) => (
              <MenuItem key={provider} value={provider}>
                {provider === 'auto' ? copy.autoProvider : provider}
              </MenuItem>
            ))}
          </TextField>
          {node.runtime ? (
            <Stack direction="row" spacing={1}>
              <TextField
                size="small"
                fullWidth
                label={copy.runtimeModel}
                value={node.runtime.model}
                onChange={(event) => onChange((current) => current.type === 'llm_agent' && current.runtime
                  ? { ...current, runtime: { ...current.runtime, model: event.target.value } }
                  : current)}
              />
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
                {EFFORT_OPTIONS.map((effort) => (
                  <MenuItem key={effort} value={effort}>{effort}</MenuItem>
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
            options={toolOptions.map((option) => option.id)}
            getOptionLabel={(toolId) => toolOptions.find((option) => option.id === toolId)?.label ?? toolId}
            value={node.toolIds}
            onChange={(_event, value) => onChange((current) => current.type === 'llm_agent'
              ? { ...current, toolIds: value as typeof current.toolIds }
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
    </Stack>
  );
};
