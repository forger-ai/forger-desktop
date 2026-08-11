import { useState } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { MappingMenuButton, SchemaForm } from '@renderer/views/workflows/SchemaForm';
import type { TemplateSourceNode } from '@renderer/views/workflows/TemplateEditor';

const sources: TemplateSourceNode[] = [
  {
    nodeId: 'collect',
    nodeName: 'Collect data',
    fields: [
      { path: 'title', sample: 'Quarterly report' },
      { path: 'totals.count', sample: 12 },
      { path: 'optional' },
    ],
  },
  {
    nodeId: 'each',
    nodeName: 'Current item',
    referenceBase: 'item',
    fields: [{ path: 'email', sample: 'person@example.com' }],
  },
];

const labels = {
  mapTooltip: 'Insert workflow data',
  wholeOutputLabel: 'Whole output',
  triggerGroupLabel: 'Trigger',
};

const renderSchema = (schema: Record<string, unknown>, initial: Record<string, unknown>, sourceNodes = sources) => {
  const changes = vi.fn();
  const Harness = () => {
    const [value, setValue] = useState(initial);
    return (
      <>
        <SchemaForm
          schema={schema}
          value={value}
          onChange={(next) => { changes(next); setValue(next); }}
          sources={sourceNodes}
          {...labels}
        />
        <output data-testid="value">{JSON.stringify(value)}</output>
      </>
    );
  };
  render(<Harness />);
  return changes;
};

describe('SchemaForm', () => {
  it('renders enum and boolean fields and removes unchecked optional values', async () => {
    const user = userEvent.setup();
    const changes = renderSchema({
      required: ['mode', 3],
      properties: {
        mode: { type: 'string', description: 'Delivery mode', enum: ['fast', 7] },
        enabled: { type: 'boolean' },
        ignoredShape: null,
      },
    }, { mode: 12, enabled: true });

    expect(screen.getByLabelText('mode *')).toBeVisible();
    await user.click(screen.getByLabelText('mode *'));
    await user.click(screen.getByRole('option', { name: '7' }));
    expect(changes).toHaveBeenLastCalledWith({ mode: '7', enabled: true });

    const enabled = screen.getByRole('checkbox', { name: 'enabled' });
    expect(enabled).toBeChecked();
    await user.click(enabled);
    expect(changes).toHaveBeenLastCalledWith({ mode: '7' });
    await user.click(enabled);
    expect(changes).toHaveBeenLastCalledWith({ mode: '7', enabled: true });
  });

  it('parses arrays, preserves template references, and exposes every mapping source', async () => {
    const user = userEvent.setup();
    const changes = renderSchema({
      properties: {
        recipients: { type: 'array', description: 'One address per line', items: { type: 'string' } },
      },
    }, { recipients: ['one@example.com', { team: 'ops' }] });

    const recipients = screen.getByLabelText('recipients');
    expect(recipients).toHaveValue('one@example.com\n{"team":"ops"}');
    fireEvent.change(recipients, { target: { value: 'one@example.com, two@example.com\nthree@example.com' } });
    expect(changes).toHaveBeenLastCalledWith({ recipients: ['one@example.com', 'two@example.com', 'three@example.com'] });

    fireEvent.change(recipients, { target: { value: '{{trigger.type}}' } });
    expect(changes).toHaveBeenLastCalledWith({ recipients: '{{trigger.type}}' });

    await user.click(screen.getByRole('button', { name: labels.mapTooltip }));
    expect(screen.getByText('Collect data')).toBeVisible();
    expect(screen.getByText('Current item')).toBeVisible();
    expect(screen.getByText('Quarterly report')).toBeVisible();
    expect(screen.getByText('12')).toBeVisible();
    await user.click(screen.getByRole('menuitem', { name: /totals\.count/ }));
    expect(changes).toHaveBeenLastCalledWith({ recipients: ['{{trigger.type}}', '{{nodes.collect.output.totals.count}}'] });

    await user.clear(recipients);
    await user.click(screen.getByRole('button', { name: labels.mapTooltip }));
    const menu = screen.getByRole('menu');
    await user.click(within(menu).getAllByRole('menuitem', { name: labels.wholeOutputLabel })[1]);
    expect(changes).toHaveBeenLastCalledWith({ recipients: '{{item}}' });

    await user.clear(recipients);
    expect(changes).toHaveBeenLastCalledWith({});
  });

  it('normalizes scalar values and appends mappings to fixed and templated text', async () => {
    const user = userEvent.setup();
    const changes = renderSchema({
      required: 'invalid',
      properties: {
        amount: { type: 'number', description: 'Amount' },
        text: { type: 'string' },
        description: { type: 'string' },
        body: { type: 'string' },
        objectValue: {},
      },
    }, {
      amount: null,
      text: 'Hello ',
      description: '{{trigger.type}}',
      body: { rich: true },
      objectValue: undefined,
    });

    const amount = screen.getByLabelText('amount');
    await user.type(amount, '42');
    expect(changes).toHaveBeenLastCalledWith(expect.objectContaining({ amount: 42 }));
    await user.clear(amount);
    await user.type(amount, 'not-a-number');
    expect(changes).toHaveBeenLastCalledWith(expect.objectContaining({ amount: 'not-a-number' }));
    fireEvent.change(amount, { target: { value: '{{nodes.collect.output.total}}' } });
    expect(changes).toHaveBeenLastCalledWith(expect.objectContaining({ amount: '{{nodes.collect.output.total}}' }));

    expect(screen.getByLabelText('text').tagName).toBe('TEXTAREA');
    expect(screen.getByLabelText('description').tagName).toBe('TEXTAREA');
    expect(screen.getByLabelText('body')).toHaveValue('{"rich":true}');
    expect(screen.getByLabelText('objectValue')).toHaveValue('');

    const mapButtons = screen.getAllByRole('button', { name: labels.mapTooltip });
    await user.click(mapButtons[1]);
    await user.click(screen.getByRole('menuitem', { name: 'type' }));
    expect(changes).toHaveBeenLastCalledWith(expect.objectContaining({ text: 'Hello {{trigger.type}}' }));

    const refreshedButtons = screen.getAllByRole('button', { name: labels.mapTooltip });
    await user.click(refreshedButtons[2]);
    await user.click(screen.getByRole('menuitem', { name: 'firedAt' }));
    expect(changes).toHaveBeenLastCalledWith(expect.objectContaining({ description: '{{trigger.type}}{{trigger.firedAt}}' }));

    await user.click(screen.getAllByRole('button', { name: labels.mapTooltip })[4]);
    await user.click(screen.getByRole('menuitem', { name: 'type' }));
    expect(changes).toHaveBeenLastCalledWith(expect.objectContaining({ objectValue: '{{trigger.type}}' }));
  });

  it('renders nothing for invalid schemas, accepts direct string arrays, and closes mapping menus', async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <SchemaForm schema={{ properties: [] }} value={{}} onChange={vi.fn()} sources={[]} {...labels} />,
    );
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();

    const onChange = vi.fn();
    rerender(
      <SchemaForm
        schema={{ properties: { tags: { type: 'array', items: { type: 'string' } } } }}
        value={{ tags: 'already templated' }}
        onChange={onChange}
        sources={[]}
        {...labels}
      />,
    );
    expect(screen.getByLabelText('tags')).toHaveValue('already templated');
    fireEvent.change(screen.getByLabelText('tags'), { target: { value: '   ' } });
    expect(onChange).toHaveBeenCalledWith({});
    fireEvent.change(screen.getByLabelText('tags'), { target: { value: ',,\n' } });
    expect(onChange).toHaveBeenLastCalledWith({});

    rerender(
      <SchemaForm schema={{ properties: { plain: { type: 'string' } } }} value={{}} onChange={onChange} sources={[]} {...labels} />,
    );
    expect(screen.getByLabelText('plain')).toBeVisible();

    const picked = vi.fn();
    rerender(
      <MappingMenuButton
        sources={sources}
        tooltip={labels.mapTooltip}
        wholeOutputLabel={labels.wholeOutputLabel}
        triggerGroupLabel={labels.triggerGroupLabel}
        onPick={picked}
      />,
    );
    await user.click(screen.getByRole('button', { name: labels.mapTooltip }));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });
});
