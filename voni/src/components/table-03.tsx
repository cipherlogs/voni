'use client';

/**
 * Vendored from Blocks (MIT ©2025 Ephraim Duncan) — registry item
 * `@blocks-so/table-03` (https://blocks.so/r/table-03.json).
 * See voni/THIRD-PARTY-NOTICES.md. Pinned per voni/DESIGN.md §3.
 * Adaptations for this project: SelectGroup wrapper added around the
 * category SelectItems (house composition rule); outer `space-y-6`
 * stack converted to flex-col gap; status tints remapped from hardcoded
 * green/amber/rose/blue + dark: utilities to oklch semantic tokens
 * (DESIGN.md §5); upstream `items=` prop on Select dropped (not in this
 * project's Select primitive — items declared via SelectItem children);
 * `getStatusBadge` switch reshaped to the table-05 statusConfig Record
 * idiom. No client pagination adopted — server pagination stays.
 */

import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';

type Status = 'active' | 'pending' | 'discontinued' | 'on-hold';

interface Product {
  sku: string;
  productName: string;
  stockLevel: number;
  category: string;
  status: Status;
  unitPrice: string;
  lastRestocked: string;
}

const data: Product[] = [
  {
    sku: 'SKU-8472',
    productName: 'Wireless Mouse Pro',
    stockLevel: 245,
    category: 'Electronics',
    status: 'active',
    unitPrice: '$24.99',
    lastRestocked: 'Oct 15, 2024',
  },
  {
    sku: 'SKU-3391',
    productName: 'Ergonomic Keyboard',
    stockLevel: 89,
    category: 'Electronics',
    status: 'active',
    unitPrice: '$79.99',
    lastRestocked: 'Oct 18, 2024',
  },
  {
    sku: 'SKU-7156',
    productName: 'Office Chair Deluxe',
    stockLevel: 12,
    category: 'Furniture',
    status: 'pending',
    unitPrice: '$299.99',
    lastRestocked: 'Oct 12, 2024',
  },
  {
    sku: 'SKU-9204',
    productName: 'USB-C Hub Adapter',
    stockLevel: 456,
    category: 'Accessories',
    status: 'active',
    unitPrice: '$34.50',
    lastRestocked: 'Oct 19, 2024',
  },
  {
    sku: 'SKU-1638',
    productName: 'Standing Desk Frame',
    stockLevel: 5,
    category: 'Furniture',
    status: 'on-hold',
    unitPrice: '$449.00',
    lastRestocked: 'Oct 10, 2024',
  },
  {
    sku: 'SKU-5529',
    productName: 'Laptop Stand Aluminum',
    stockLevel: 178,
    category: 'Accessories',
    status: 'active',
    unitPrice: '$45.99',
    lastRestocked: 'Oct 17, 2024',
  },
  {
    sku: 'SKU-4817',
    productName: 'Mechanical Keyboard RGB',
    stockLevel: 0,
    category: 'Electronics',
    status: 'discontinued',
    unitPrice: '$129.99',
    lastRestocked: 'Oct 05, 2024',
  },
];

const statusConfig: Record<Status, { label: string; className: string }> = {
  active: {
    label: 'Active',
    className: 'bg-primary text-primary-foreground',
  },
  pending: {
    label: 'Pending',
    className: 'bg-secondary text-secondary-foreground',
  },
  discontinued: {
    label: 'Discontinued',
    className: 'bg-destructive/10 text-destructive',
  },
  'on-hold': {
    label: 'On Hold',
    className: 'bg-primary/10 text-primary',
  },
};

function StatusBadge({ status }: { status: Status }) {
  const config = statusConfig[status];
  return (
    <Badge className={cn('border-0', config.className)} variant="outline">
      {config.label}
    </Badge>
  );
}

export default function Table03() {
  const [selectedCategory, setSelectedCategory] = useState<string>('all');

  const filteredData = data.filter((item) => {
    const categoryMatch =
      selectedCategory === 'all' || item.category === selectedCategory;
    return categoryMatch;
  });

  const uniqueCategories = Array.from(
    new Set(data.map((item) => item.category))
  );

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h3 className="text-balance font-semibold text-foreground text-lg">
            Product Inventory
          </h3>
          <p className="mt-1 text-pretty text-muted-foreground text-sm">
            Track and manage product stock levels across all warehouse
            locations.
          </p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Select
            onValueChange={(value) => {
              if (value) {
                setSelectedCategory(value);
              }
            }}
            value={selectedCategory}
          >
            <SelectTrigger className="w-full sm:w-[180px]">
              <SelectValue placeholder="Filter by category" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="all">All Categories</SelectItem>
                {uniqueCategories.map((category) => (
                  <SelectItem key={category} value={category}>
                    {category}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="rounded-lg border bg-card">
        <Table>
          <TableHeader>
            <TableRow className="border-b hover:bg-transparent">
              <TableHead className="h-12 px-4 font-medium">SKU</TableHead>
              <TableHead className="h-12 px-4 font-medium">
                Product Name
              </TableHead>
              <TableHead className="h-12 px-4 font-medium">Category</TableHead>
              <TableHead className="h-12 px-4 font-medium">Status</TableHead>
              <TableHead className="h-12 px-4 text-right font-medium">
                Unit Price
              </TableHead>
              <TableHead className="h-12 px-4 text-right font-medium">
                Last Restocked
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredData.length > 0 ? (
              filteredData.map((item) => (
                <TableRow className="hover:bg-muted/50" key={item.sku}>
                  <TableCell className="h-14 px-4 font-medium font-mono text-sm tabular-nums">
                    {item.sku}
                  </TableCell>
                  <TableCell className="h-14 px-4 font-medium">
                    {item.productName}
                  </TableCell>
                  <TableCell className="h-14 px-4 text-muted-foreground text-sm">
                    {item.category}
                  </TableCell>
                  <TableCell className="h-14 px-4">
                    <StatusBadge status={item.status} />
                  </TableCell>
                  <TableCell className="h-14 px-4 text-right font-mono font-semibold text-sm tabular-nums">
                    {item.unitPrice}
                  </TableCell>
                  <TableCell className="h-14 px-4 text-right text-muted-foreground text-sm">
                    {item.lastRestocked}
                  </TableCell>
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell
                  className="h-24 text-center text-muted-foreground"
                  colSpan={6}
                >
                  No products found matching the selected filters.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
