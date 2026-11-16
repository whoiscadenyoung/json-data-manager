import { Badge } from "@caden/ui/components/badge";
import { useColorScheme } from "@caden/ui/hooks/use-color-scheme";
import { cn } from "@caden/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";

// oxlint-disable-next-line import/no-unassigned-import -- React Flow's stylesheet is a side-effect import.
import "@xyflow/react/dist/style.css";
import {
  Background,
  BaseEdge,
  Controls,
  EdgeLabelRenderer,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  getBezierPath,
  type Edge,
  type EdgeProps,
  type EdgeTypes,
  type Node,
  type NodeProps,
  type NodeTypes,
} from "@xyflow/react";
import {
  AppWindow,
  CircleHelp,
  Database,
  Flag,
  Layers,
  Map as MapIcon,
  Table2,
  Workflow,
  type LucideIcon,
} from "lucide-react";

import type { Graph, GraphEdge, GraphNode } from "../lib/graph-types";
import { NODE_HEIGHT, NODE_WIDTH, graphSignature, layoutGraph } from "../lib/layout";
import { STEP_KIND_VISUALS } from "../lib/step-kind";

/**
 * The React Flow drawing of a `Graph`. This module pulls in @xyflow/react
 * (DOM measuring, ResizeObserver) and elkjs, so it is only ever loaded
 * through the lazy, client-only wrapper in `graph-view.tsx`.
 */

export interface GraphViewImplProps {
  graph: Graph;
  selectedNodeId?: string | null;
  onNodeClick?: (node: GraphNode) => void;
  className?: string;
  ariaLabel: string;
  /** Which nodes react to a click (default: all of them when `onNodeClick` is set). */
  isNodeClickable?: (node: GraphNode) => boolean;
  /** The smallest zoom the initial fit may use (default: fit everything). Long graphs then start readable and pan. */
  fitMinZoom?: number;
  /** A control drawn on the middle of an edge (the step graph's "insert a step here"). */
  renderEdgeAction?: (edge: GraphEdge) => React.ReactNode;
}

const KIND_ICON: Record<GraphNode["kind"], LucideIcon> = {
  app: AppWindow,
  dataset: Database,
  input: Table2,
  layer: Layers,
  map: MapIcon,
  output: Flag,
  step: Workflow,
  view: Table2,
};

const BADGE_VARIANT = {
  error: "destructive",
  neutral: "secondary",
  warning: "outline",
} as const;

interface CardData extends Record<string, unknown> {
  node: GraphNode;
  selected: boolean;
  clickable: boolean;
}

function statusClasses(node: GraphNode): string {
  if (node.status === "error" || (node.badge !== undefined && node.badge.tone === "error")) {
    return "border-destructive";
  }
  if (node.badge !== undefined && node.badge.tone === "neutral") {
    return "border-dashed border-muted-foreground";
  }
  return node.status === "stale" ? "border-dashed border-primary" : "border-border";
}

function GraphNodeCard({ data }: NodeProps<Node<CardData>>) {
  const { node, selected, clickable } = data;
  const visual = node.stepKind === undefined ? undefined : STEP_KIND_VISUALS[node.stepKind];
  const Icon =
    node.unavailable === true
      ? CircleHelp
      : visual === undefined
        ? KIND_ICON[node.kind]
        : visual.icon;
  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-lg border bg-card px-3 text-card-foreground shadow-xs",
        statusClasses(node),
        selected ? "border-primary ring-2 ring-primary/30" : "",
        clickable ? "cursor-pointer hover:bg-muted" : "",
        node.unavailable === true ? "text-muted-foreground" : "",
      )}
      data-kind={node.kind}
      data-status={node.status}
      style={{ height: NODE_HEIGHT, width: NODE_WIDTH }}
    >
      <Handle
        className="!size-1.5 !border-0 !bg-muted-foreground"
        position={Position.Left}
        type="target"
      />
      {visual === undefined ? (
        <Icon className="size-4 shrink-0 text-muted-foreground" />
      ) : (
        <span
          className={cn("flex size-7 shrink-0 items-center justify-center rounded-md", visual.tone)}
        >
          <Icon className="size-4" />
        </span>
      )}
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm leading-tight font-medium" title={node.label}>
          {node.label}
        </div>
        {node.detail === undefined ? null : (
          <div className="truncate text-xs text-muted-foreground">{node.detail}</div>
        )}
      </div>
      {node.badge === undefined ? null : (
        <Badge
          className={node.badge.tone === "warning" ? "border-amber-500 text-amber-700" : undefined}
          variant={BADGE_VARIANT[node.badge.tone]}
        >
          {node.badge.label}
        </Badge>
      )}
      {node.status === "error" ? <Badge variant="destructive">Failed</Badge> : null}
      {node.status === "stale" ? <Badge variant="outline">Stale</Badge> : null}
      <Handle
        className="!size-1.5 !border-0 !bg-muted-foreground"
        position={Position.Right}
        type="source"
      />
    </div>
  );
}

const nodeTypes: NodeTypes = { card: GraphNodeCard };

const EDGE_STROKE = "var(--muted-foreground)";

interface ActionData extends Record<string, unknown> {
  action: React.ReactNode;
}

/** An edge with a control on its midpoint. The control takes clicks; the pane does not pan or drag from it. */
function ActionEdge({
  data,
  id,
  markerEnd,
  sourcePosition,
  sourceX,
  sourceY,
  style,
  targetPosition,
  targetX,
  targetY,
}: EdgeProps<Edge<ActionData>>) {
  const [path, labelX, labelY] = getBezierPath({
    sourcePosition,
    sourceX,
    sourceY,
    targetPosition,
    targetX,
    targetY,
  });
  return (
    <>
      <BaseEdge id={id} markerEnd={markerEnd} path={path} style={style} />
      <EdgeLabelRenderer>
        <div
          className="nodrag nopan pointer-events-auto absolute"
          style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
        >
          {data === undefined ? null : data.action}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

const edgeTypes: EdgeTypes = { action: ActionEdge };

const DASHES: Partial<Record<GraphEdge["kind"], string>> = { branch: "4 4", relation: "6 4" };

function flowEdge(edge: GraphEdge, action: React.ReactNode): Edge {
  return {
    ...(action === undefined || action === null ? {} : { data: { action }, type: "action" }),
    id: edge.id,
    label: edge.label,
    labelBgStyle: { fill: "var(--background)" },
    labelStyle: { fill: "var(--muted-foreground)", fontSize: 11 },
    markerEnd: { color: EDGE_STROKE, type: MarkerType.ArrowClosed },
    source: edge.source,
    style: {
      stroke: EDGE_STROKE,
      strokeDasharray: DASHES[edge.kind],
      strokeWidth: 1.5,
    },
    target: edge.target,
  };
}

export function GraphViewImpl({
  graph,
  selectedNodeId = null,
  onNodeClick,
  className,
  ariaLabel,
  isNodeClickable,
  fitMinZoom,
  renderEdgeAction,
}: GraphViewImplProps) {
  const colorScheme = useColorScheme();
  const signature = graphSignature(graph);
  const layout = useQuery({
    queryFn: async () => await layoutGraph(graph),
    queryKey: ["view-graphs", "layout", signature],
    staleTime: Infinity,
  });

  if (layout.data === undefined) {
    return (
      <div
        aria-busy={layout.isPending}
        aria-label={ariaLabel}
        className={cn("h-full w-full animate-pulse rounded-lg bg-muted", className)}
      />
    );
  }

  const positions = layout.data.positions;
  const nodes: Node<CardData>[] = graph.nodes.map((node) => ({
    data: {
      clickable:
        onNodeClick !== undefined && (isNodeClickable === undefined || isNodeClickable(node)),
      node,
      selected: node.id === selectedNodeId,
    },
    draggable: false,
    id: node.id,
    position: positions[node.id] ?? { x: 0, y: 0 },
    type: "card",
    width: NODE_WIDTH,
    height: NODE_HEIGHT,
  }));

  return (
    <section
      aria-label={ariaLabel}
      className={cn("h-full w-full overflow-hidden rounded-lg border bg-background", className)}
    >
      <ReactFlow
        colorMode={colorScheme}
        edges={graph.edges.map((edge) =>
          flowEdge(edge, renderEdgeAction === undefined ? undefined : renderEdgeAction(edge)),
        )}
        edgeTypes={edgeTypes}
        elementsSelectable={false}
        fitView
        // Never fit past 100%: a two-node graph would otherwise fill the box with giant cards.
        fitViewOptions={
          fitMinZoom === undefined ? { maxZoom: 1 } : { maxZoom: 1, minZoom: fitMinZoom }
        }
        key={signature}
        maxZoom={1.5}
        minZoom={0.2}
        nodes={nodes}
        nodesConnectable={false}
        nodesDraggable={false}
        nodeTypes={nodeTypes}
        onNodeClick={(_event, flowNode) => {
          const clicked = graph.nodes.find((node) => node.id === flowNode.id);
          if (clicked !== undefined && onNodeClick !== undefined) {
            onNodeClick(clicked);
          }
        }}
      >
        <Background />
        <Controls showInteractive={false} />
      </ReactFlow>
    </section>
  );
}
