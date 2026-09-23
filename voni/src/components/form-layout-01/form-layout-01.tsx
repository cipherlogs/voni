/**
 * Vendored from Blocks (MIT ©2025 Ephraim Duncan) — registry item
 * `@blocks-so/form-layout-01` (https://blocks.so/r/form-layout-01.json).
 * See voni/THIRD-PARTY-NOTICES.md. Pinned per voni/DESIGN.md §3.
 * Adaptations for this project: heading + post form + responsive
 * lattice + ruled Separator + right-aligned outline-abort /
 * primary-confirm bar kept with agent-setup content; 7-field workspace
 * lattice (first/last/email/address/city/state/postal) NOT adopted —
 * replaced by agent name/role/greeting fields; red * required marks
 * replaced with FieldError slots (house data-invalid/aria-invalid
 * invalid-state pattern, errors wired to required-field validation);
 * footer spaced stack rebuilt as flex+gap; dark-mode duplicates stripped.
 * Deps: button/field/input/separator Base UI variants; +0 npm.
 */

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Field, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { Textarea } from '@/components/ui/textarea';

export default function FormLayout01() {
  const [name, setName] = useState('');
  const [role, setRole] = useState('');
  const [greeting, setGreeting] = useState('');
  const [submitted, setSubmitted] = useState(false);

  const nameInvalid = submitted && !name.trim();
  const roleInvalid = submitted && !role.trim();
  const greetingInvalid = submitted && !greeting.trim();

  return (
    <section className="w-full sm:max-w-2xl">
      <h3 className="text-balance font-semibold text-2xl text-foreground">
        Agent basics
      </h3>
      <p className="mt-1 text-pretty text-muted-foreground text-sm">
        Name the agent and set how it introduces itself on calls
      </p>
      <form
        action="#"
        className="mt-8"
        method="post"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          setSubmitted(true);
        }}
      >
        <FieldGroup>
          <div className="grid grid-cols-1 gap-x-4 gap-y-6 sm:grid-cols-6">
            <div className="col-span-full sm:col-span-3">
              <Field className="gap-2">
                <FieldLabel htmlFor="agent-name">Agent name</FieldLabel>
                <Input
                  aria-invalid={nameInvalid || undefined}
                  autoComplete="off"
                  data-invalid={nameInvalid || undefined}
                  id="agent-name"
                  name="agent-name"
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Vera"
                  required
                  type="text"
                  value={name}
                />
                {nameInvalid && (
                  <FieldError>Agent name is required.</FieldError>
                )}
              </Field>
            </div>
            <div className="col-span-full sm:col-span-3">
              <Field className="gap-2">
                <FieldLabel htmlFor="agent-role">Role</FieldLabel>
                <Input
                  aria-invalid={roleInvalid || undefined}
                  autoComplete="off"
                  data-invalid={roleInvalid || undefined}
                  id="agent-role"
                  name="agent-role"
                  onChange={(e) => setRole(e.target.value)}
                  placeholder="Property viewing coordinator"
                  required
                  type="text"
                  value={role}
                />
                {roleInvalid && <FieldError>Role is required.</FieldError>}
              </Field>
            </div>
            <div className="col-span-full">
              <Field className="gap-2">
                <FieldLabel htmlFor="agent-greeting">Greeting</FieldLabel>
                <Textarea
                  aria-invalid={greetingInvalid || undefined}
                  data-invalid={greetingInvalid || undefined}
                  id="agent-greeting"
                  name="agent-greeting"
                  onChange={(e) => setGreeting(e.target.value)}
                  placeholder="Hi, this is Vera calling about your viewing request"
                  required
                  rows={3}
                  value={greeting}
                />
                {greetingInvalid && (
                  <FieldError>Greeting is required.</FieldError>
                )}
              </Field>
            </div>
          </div>
        </FieldGroup>
        <Separator className="my-6" />
        <div className="flex items-center justify-end gap-4">
          <Button className="whitespace-nowrap" type="button" variant="outline">
            Cancel
          </Button>
          <Button className="whitespace-nowrap" type="submit">
            Save basics
          </Button>
        </div>
      </form>
    </section>
  );
}
