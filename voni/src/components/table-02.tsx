'use client';

/**
 * Vendored from Blocks (MIT ©2025 Ephraim Duncan) — registry item
 * `@blocks-so/table-02` (https://blocks.so/r/table-02.json).
 * See voni/THIRD-PARTY-NOTICES.md. Pinned per voni/DESIGN.md §3.
 * Adaptations for this project: row actions converted from the upstream
 * tooltip icon-button cluster to the conditional DropdownMenu idiom
 * (DropdownMenuItems in DropdownMenuGroups, per-item pending state —
 * tooltip primitive not vendored); notes cell renders as truncated text
 * (notes-tooltip cut with tooltip); status tints remapped from hardcoded
 * amber/blue/green/rose + dark: utilities to oklch semantic tokens
 * (DESIGN.md §5); unrendered upstream `priority` field cut; `w-[95%]`
 * wrapper remapped to w-full; `getStatusBadge` switch reshaped to the
 * table-05 statusConfig Record idiom.
 */

import {
  CheckCircle,
  FileTextIcon,
  Loader2,
  MoreHorizontal,
  PauseIcon,
  PlayIcon,
  Trash2Icon,
} from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';

type TaskStatus = 'pending' | 'in-progress' | 'completed' | 'blocked';

interface Task {
  id: string;
  title: string;
  assignee: string;
  status: TaskStatus;
  dueDate: string;
  notes: string;
}

type TaskActionType = 'start' | 'pause' | 'complete' | 'delete' | 'view';

const statusConfig: Record<TaskStatus, { label: string; className: string }> = {
  pending: {
    label: 'Pending',
    className: 'bg-secondary text-secondary-foreground',
  },
  'in-progress': {
    label: 'In Progress',
    className: 'bg-primary/10 text-primary',
  },
  completed: {
    label: 'Completed',
    className: 'bg-primary text-primary-foreground',
  },
  blocked: {
    label: 'Blocked',
    className: 'bg-destructive/10 text-destructive',
  },
};

function StatusBadge({ status }: { status: TaskStatus }) {
  const config = statusConfig[status];
  return (
    <Badge className={cn('border-0', config.className)} variant="outline">
      {config.label}
    </Badge>
  );
}

const tasks: Task[] = [
  {
    id: 'TASK-001',
    title: 'Implement User Authentication',
    assignee: 'Sarah Chen',
    status: 'in-progress',
    dueDate: '2024-03-25',
    notes: 'OAuth 2.0 integration with Google and GitHub providers',
  },
  {
    id: 'TASK-002',
    title: 'Design Dashboard UI',
    assignee: 'Michael Torres',
    status: 'completed',
    dueDate: '2024-03-20',
    notes: 'Finalize dashboard layout with responsive grid system',
  },
  {
    id: 'TASK-003',
    title: 'API Performance Optimization',
    assignee: 'Emma Rodriguez',
    status: 'pending',
    dueDate: '2024-03-22',
    notes: 'Reduce API response time by implementing caching strategy',
  },
  {
    id: 'TASK-004',
    title: 'Write Unit Tests',
    assignee: 'James Wilson',
    status: 'in-progress',
    dueDate: '2024-03-28',
    notes: 'Achieve 80% code coverage for authentication module',
  },
  {
    id: 'TASK-005',
    title: 'Database Migration',
    assignee: 'Olivia Martinez',
    status: 'blocked',
    dueDate: '2024-03-24',
    notes: 'Waiting for infrastructure team approval before proceeding',
  },
  {
    id: 'TASK-006',
    title: 'Update Documentation',
    assignee: 'Lucas Anderson',
    status: 'pending',
    dueDate: '2024-03-30',
    notes: 'Document new API endpoints and authentication flow',
  },
  {
    id: 'TASK-007',
    title: 'Security Audit',
    assignee: 'Sophia Taylor',
    status: 'completed',
    dueDate: '2024-03-19',
    notes:
      'Conducted comprehensive security review and vulnerability assessment',
  },
];

export default function Table02() {
  const [pendingAction, setPendingAction] = useState<{
    id: string;
    type: TaskActionType;
  } | null>(null);

  const isTaskActionPending = (action: TaskActionType, taskId: string) =>
    pendingAction?.id === taskId && pendingAction.type === action;

  const isTaskBusy = (taskId: string) => pendingAction?.id === taskId;

  const handleAction = (task: Task, actionType: TaskActionType) => {
    setPendingAction({ id: task.id, type: actionType });
    setTimeout(() => {
      setPendingAction(null);
      console.log(`Action "${actionType}" completed for task:`, task.title);
    }, 1000);
  };

  const renderTaskRow = (task: Task) => {
    const busy = isTaskBusy(task.id);
    const startPending = isTaskActionPending('start', task.id);
    const pausePending = isTaskActionPending('pause', task.id);
    const completePending = isTaskActionPending('complete', task.id);
    const deletePending = isTaskActionPending('delete', task.id);
    const viewPending = isTaskActionPending('view', task.id);

    return (
      <TableRow className="hover:bg-muted/50" key={task.id}>
        <TableCell className="h-16 px-4 font-medium">{task.title}</TableCell>
        <TableCell className="h-16 px-4 text-muted-foreground text-sm">
          {task.assignee}
        </TableCell>
        <TableCell className="h-16 px-4">
          <StatusBadge status={task.status} />
        </TableCell>
        <TableCell className="h-16 px-4 text-muted-foreground text-sm">
          {task.dueDate}
        </TableCell>
        <TableCell className="h-16 max-w-75 px-4 text-muted-foreground text-sm">
          <span className="block truncate">{task.notes}</span>
        </TableCell>
        <TableCell className="h-16 px-4">
          <div className="text-right">
            <DropdownMenu>
              <DropdownMenuTrigger
                render={<Button className="h-8 w-8" size="icon" variant="ghost" />}
              >
                <MoreHorizontal className="size-4" />
                <span className="sr-only">Open menu</span>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuGroup>
                  <DropdownMenuItem
                    disabled={busy}
                    onSelect={() => handleAction(task, 'view')}
                  >
                    {viewPending ? (
                      <Loader2 className="mr-2 size-4 animate-spin" />
                    ) : (
                      <FileTextIcon className="mr-2 size-4" />
                    )}
                    View details
                  </DropdownMenuItem>
                  {(task.status === 'pending' ||
                    task.status === 'blocked') && (
                    <DropdownMenuItem
                      disabled={busy}
                      onSelect={() => handleAction(task, 'start')}
                    >
                      {startPending ? (
                        <Loader2 className="mr-2 size-4 animate-spin" />
                      ) : (
                        <PlayIcon className="mr-2 size-4" />
                      )}
                      Start
                    </DropdownMenuItem>
                  )}
                  {task.status === 'in-progress' && (
                    <>
                      <DropdownMenuItem
                        disabled={busy}
                        onSelect={() => handleAction(task, 'pause')}
                      >
                        {pausePending ? (
                          <Loader2 className="mr-2 size-4 animate-spin" />
                        ) : (
                          <PauseIcon className="mr-2 size-4" />
                        )}
                        Pause
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        disabled={busy}
                        onSelect={() => handleAction(task, 'complete')}
                      >
                        {completePending ? (
                          <Loader2 className="mr-2 size-4 animate-spin" />
                        ) : (
                          <CheckCircle className="mr-2 size-4" />
                        )}
                        Complete
                      </DropdownMenuItem>
                    </>
                  )}
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
                <DropdownMenuGroup>
                  <DropdownMenuItem
                    className="text-destructive"
                    disabled={busy}
                    onSelect={() => handleAction(task, 'delete')}
                  >
                    {deletePending ? (
                      <Loader2 className="mr-2 size-4 animate-spin" />
                    ) : (
                      <Trash2Icon className="mr-2 size-4" />
                    )}
                    Delete
                  </DropdownMenuItem>
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </TableCell>
      </TableRow>
    );
  };

  return (
    <div className="w-full rounded-lg border bg-card">
      <Table>
        <TableHeader>
          <TableRow className="border-b hover:bg-transparent">
            <TableHead className="h-12 px-4 font-medium">Title</TableHead>
            <TableHead className="h-12 px-4 font-medium">Assignee</TableHead>
            <TableHead className="h-12 w-[120px] px-4 font-medium">
              Status
            </TableHead>
            <TableHead className="h-12 px-4 font-medium">Due Date</TableHead>
            <TableHead className="h-12 px-4 font-medium">Notes</TableHead>
            <TableHead className="h-12 w-[180px] px-4 font-medium">
              Actions
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>{tasks.map(renderTaskRow)}</TableBody>
      </Table>
    </div>
  );
}
