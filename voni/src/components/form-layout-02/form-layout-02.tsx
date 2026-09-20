'use client';

/**
 * Vendored from Blocks (MIT ©2025 Ephraim Duncan) — registry item
 * `@blocks-so/form-layout-02` (https://blocks.so/r/form-layout-02.json).
 * See voni/THIRD-PARTY-NOTICES.md. Pinned per voni/DESIGN.md §3.
 * Adaptations for this project: radio-group Notification section cut
 * entirely (no radios in settings/operator; radio-group primitive stays
 * uninstalled); visibility Select rewired from upstream items={} to house
 * controlled Select + SelectGroup + function-child SelectValue; footer
 * space-x-4 rebuilt as flex+gap; dark: duplicates stripped.
 */

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Textarea } from '@/components/ui/textarea';

export default function FormLayout02() {
  const [visibility, setVisibility] = useState('private');

  return (
    <div className="flex items-center justify-center p-10">
      <form>
        <div className="grid grid-cols-1 gap-10 md:grid-cols-3">
          <div>
            <h2 className="text-balance font-semibold text-foreground">
              Personal information
            </h2>
            <p className="mt-1 text-pretty text-muted-foreground text-sm leading-6">
              How your name and contact details appear across the product.
            </p>
          </div>
          <div className="sm:max-w-3xl md:col-span-2">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-6">
              <div className="col-span-full sm:col-span-3">
                <Field className="gap-2">
                  <FieldLabel htmlFor="first-name">First name</FieldLabel>
                  <Input
                    autoComplete="given-name"
                    id="first-name"
                    name="first-name"
                    placeholder="Emma"
                    type="text"
                  />
                </Field>
              </div>
              <div className="col-span-full sm:col-span-3">
                <Field className="gap-2">
                  <FieldLabel htmlFor="last-name">Last name</FieldLabel>
                  <Input
                    autoComplete="family-name"
                    id="last-name"
                    name="last-name"
                    placeholder="Crown"
                    type="text"
                  />
                </Field>
              </div>
              <div className="col-span-full">
                <Field className="gap-2">
                  <FieldLabel htmlFor="email">Email</FieldLabel>
                  <Input
                    autoComplete="email"
                    id="email"
                    name="email"
                    placeholder="emma@company.com"
                    type="email"
                  />
                </Field>
              </div>
              <div className="col-span-full sm:col-span-3">
                <Field className="gap-2">
                  <FieldLabel htmlFor="birthyear">Birth year</FieldLabel>
                  <Input
                    id="birthyear"
                    name="year"
                    placeholder="1990"
                    type="number"
                  />
                </Field>
              </div>
              <div className="col-span-full sm:col-span-3">
                <Field className="gap-2">
                  <FieldLabel htmlFor="role">Role</FieldLabel>
                  <Input
                    disabled
                    id="role"
                    name="role"
                    placeholder="Senior Manager"
                    type="text"
                  />
                  <FieldDescription>
                    Roles can only be changed by system admin.
                  </FieldDescription>
                </Field>
              </div>
            </div>
          </div>
        </div>
        <Separator className="my-8" />
        <div className="grid grid-cols-1 gap-10 md:grid-cols-3">
          <div>
            <h2 className="text-balance font-semibold text-foreground">
              Workspace settings
            </h2>
            <p className="mt-1 text-pretty text-muted-foreground text-sm leading-6">
              Defaults shared by everyone in this workspace.
            </p>
          </div>
          <div className="sm:max-w-3xl md:col-span-2">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-6">
              <div className="col-span-full sm:col-span-3">
                <Field className="gap-2">
                  <FieldLabel htmlFor="workspace-name">
                    Workspace name
                  </FieldLabel>
                  <Input
                    id="workspace-name"
                    name="workspace-name"
                    placeholder="Test workspace"
                    type="text"
                  />
                </Field>
              </div>
              <div className="col-span-full sm:col-span-3">
                <Field className="gap-2">
                  <FieldLabel htmlFor="visibility">Visibility</FieldLabel>
                  <Select onValueChange={(value) => setVisibility(value ?? "private")} value={visibility}>
                    <SelectTrigger id="visibility">
                      <SelectValue placeholder="Select visibility">
                        {(value: string | null) =>
                          value === 'public' ? 'Public' : 'Private'
                        }
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectItem value="public">Public</SelectItem>
                        <SelectItem value="private">Private</SelectItem>
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </Field>
              </div>
              <div className="col-span-full">
                <Field className="gap-2">
                  <FieldLabel htmlFor="workspace-description">
                    Workspace description
                  </FieldLabel>
                  <Textarea
                    id="workspace-description"
                    name="workspace-description"
                    rows={4}
                  />
                  <FieldDescription>
                    Note: description provided will not be displayed externally.
                  </FieldDescription>
                </Field>
              </div>
            </div>
          </div>
        </div>
        <Separator className="my-8" />
        <div className="flex items-center justify-end gap-4">
          <Button className="whitespace-nowrap" type="button" variant="outline">
            Go back
          </Button>
          <Button className="whitespace-nowrap" type="submit">
            Save settings
          </Button>
        </div>
      </form>
    </div>
  );
}
