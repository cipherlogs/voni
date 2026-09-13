'use client';

/**
 * Vendored from Blocks (MIT ©2025 Ephraim Duncan) — registry item
 * `@blocks-so/table-04` (https://blocks.so/r/table-04.json).
 * See voni/THIRD-PARTY-NOTICES.md. Pinned per voni/DESIGN.md §3.
 * Adaptations for this project: ONLY the Fragment group-header rows
 * idiom (name + count) + task rows + dot-pill StatusBadge vendored —
 * AvatarStack NOT adopted (no assignees in scope; avatar primitive not
 * installed; Assigned column cut); status tints remapped from hardcoded
 * emerald/amber/blue + dark: utilities to oklch semantic tokens
 * (DESIGN.md §5); `-space-x-2` overlap + `text-[10px]` avatar micro-type
 * cut with AvatarStack.
 */

import { Fragment } from 'react';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';

interface TaskItem {
  id: string;
  task: string;
  budget: string;
  deadline: string;
  status: string;
}

interface TaskGroup {
  name: string;
  items: TaskItem[];
}

type StatusVariant = 'success' | 'warning' | 'default' | 'secondary';

const statusStyles: Record<StatusVariant, { badge: string; dot: string }> = {
  success: {
    badge: 'bg-primary text-primary-foreground',
    dot: 'bg-primary-foreground',
  },
  warning: {
    badge: 'bg-destructive/10 text-destructive',
    dot: 'bg-destructive',
  },
  default: {
    badge: 'bg-primary/10 text-primary',
    dot: 'bg-primary',
  },
  secondary: {
    badge: 'bg-muted text-muted-foreground',
    dot: 'bg-muted-foreground',
  },
};

function StatusBadge({
  status,
  variant = 'default',
}: {
  status: string;
  variant?: StatusVariant;
}) {
  const styles = statusStyles[variant];
  return (
    <Badge
      className={cn('gap-1.5 rounded-full', styles.badge)}
      variant="outline"
    >
      <span
        aria-hidden="true"
        className={cn('size-1.5 rounded-full', styles.dot)}
      />
      {status}
    </Badge>
  );
}

const data: TaskGroup[] = [
  {
    name: 'Engineering',
    items: [
      {
        id: '1',
        task: 'API Integration Overhaul',
        budget: '$32,000',
        deadline: 'Dec 15, 2024',
        status: 'In Progress',
      },
      {
        id: '2',
        task: 'Database Migration',
        budget: '$18,500',
        deadline: 'Jan 20, 2025',
        status: 'Completed',
      },
      {
        id: '3',
        task: 'Mobile App Redesign',
        budget: '$55,000',
        deadline: 'Feb 28, 2025',
        status: 'Planning',
      },
    ],
  },
  {
    name: 'Marketing',
    items: [
      {
        id: '4',
        task: 'Q1 Campaign Launch',
        budget: '$24,000',
        deadline: 'Jan 5, 2025',
        status: 'In Progress',
      },
      {
        id: '5',
        task: 'Brand Refresh Project',
        budget: '$42,000',
        deadline: 'Mar 1, 2025',
        status: 'Planning',
      },
    ],
  },
  {
    name: 'Operations',
    items: [
      {
        id: '6',
        task: 'Vendor Contract Review',
        budget: '$8,000',
        deadline: 'Dec 30, 2024',
        status: 'Completed',
      },
      {
        id: '7',
        task: 'Office Expansion Setup',
        budget: '$120,000',
        deadline: 'Apr 15, 2025',
        status: 'On Hold',
      },
    ],
  },
];

function getStatusVariant(status: string): StatusVariant {
  switch (status) {
    case 'Completed':
      return 'success';
    case 'In Progress':
      return 'default';
    case 'Planning':
      return 'secondary';
    case 'On Hold':
      return 'warning';
    default:
      return 'default';
  }
}

export default function Table04() {
  return (
    <div className="rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-48 font-medium">Task</TableHead>
            <TableHead className="font-medium">Budget</TableHead>
            <TableHead className="font-medium">Deadline</TableHead>
            <TableHead className="w-28 font-medium">Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.map((group) => (
            <Fragment key={group.name}>
              <TableRow className="bg-muted/50 hover:bg-muted/50">
                <TableCell className="py-2 font-semibold" colSpan={4}>
                  {group.name}
                  <span className="ml-2 font-normal text-muted-foreground">
                    {group.items.length}
                  </span>
                </TableCell>
              </TableRow>
              {group.items.map((item) => (
                <TableRow key={item.id}>
                  <TableCell className="font-medium">{item.task}</TableCell>
                  <TableCell>{item.budget}</TableCell>
                  <TableCell>{item.deadline}</TableCell>
                  <TableCell>
                    <StatusBadge
                      status={item.status}
                      variant={getStatusVariant(item.status)}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </Fragment>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
