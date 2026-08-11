import { createTheme, ThemeProvider } from '@mui/material/styles';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import {
  buildTemplateFieldOptions,
  pillLabelForReference,
  referenceForSource,
  TemplateEditor,
  type TemplateSourceNode,
} from '@renderer/views/workflows/TemplateEditor';

const sources: TemplateSourceNode[] = [
  {
    nodeId: 'collect',
    nodeName: 'Collect data',
    fields: [
      { path: 'title', sample: 'Quarterly report' },
      { path: 'stats.count', sample: 12 },
      { path: 'optional' },
    ],
  },
  {
    nodeId: 'each',
    nodeName: 'Current item',
    referenceBase: 'item',
    fields: [{ path: 'email', sample: { verified: true } }],
  },
];

const props = {
  label: 'Message template',
  sources,
  helperText: 'Use previous workflow data.',
  placeholder: 'Write a message',
  minHeight: 140,
  triggerGroupLabel: 'Trigger',
  wholeOutputLabel: 'Whole output',
};

const placeCaret = (node: Node, offset: number) => {
  const selection = window.getSelection();
  const range = document.createRange();
  range.setStart(node, offset);
  range.collapse(true);
  selection?.removeAllRanges();
  selection?.addRange(range);
};

describe('TemplateEditor helpers', () => {
  it('builds canonical source references and grouped options', () => {
    expect(referenceForSource(sources[0])).toBe('nodes.collect.output');
    expect(referenceForSource(sources[0], 'title')).toBe('nodes.collect.output.title');
    expect(referenceForSource(sources[1])).toBe('item');
    expect(referenceForSource(sources[1], 'email')).toBe('item.email');

    expect(buildTemplateFieldOptions(sources, 'Trigger', 'Everything')).toEqual([
      { referencePath: 'nodes.collect.output', label: 'Everything', group: 'Collect data' },
      { referencePath: 'nodes.collect.output.title', label: 'title', group: 'Collect data', sample: 'Quarterly report' },
      { referencePath: 'nodes.collect.output.stats.count', label: 'stats.count', group: 'Collect data', sample: 12 },
      { referencePath: 'nodes.collect.output.optional', label: 'optional', group: 'Collect data', sample: undefined },
      { referencePath: 'item', label: 'Everything', group: 'Current item' },
      { referencePath: 'item.email', label: 'email', group: 'Current item', sample: { verified: true } },
      { referencePath: 'trigger.type', label: 'type', group: 'Trigger' },
      { referencePath: 'trigger.firedAt', label: 'firedAt', group: 'Trigger' },
    ]);
  });

  it('labels custom, trigger, known, unknown, and invalid references', () => {
    expect(pillLabelForReference('item', sources, 'Trigger', 'Everything')).toBe('Current item · Everything');
    expect(pillLabelForReference('item.email', sources, 'Trigger', 'Everything')).toBe('Current item · email');
    expect(pillLabelForReference('trigger', sources, 'Trigger', 'Everything')).toBe('Trigger · type');
    expect(pillLabelForReference('trigger.firedAt', sources, 'Trigger', 'Everything')).toBe('Trigger · firedAt');
    expect(pillLabelForReference('nodes.collect.output', sources, 'Trigger', 'Everything')).toBe('Collect data · Everything');
    expect(pillLabelForReference('nodes.collect.output.title', sources, 'Trigger', 'Everything')).toBe('Collect data · title');
    expect(pillLabelForReference('nodes.unknown.output.value', sources, 'Trigger', 'Everything')).toBe('unknown · value');
    expect(pillLabelForReference('not-a-reference', sources, 'Trigger', 'Everything')).toBe('not-a-reference');
  });
});

describe('TemplateEditor behavior', () => {
  it('renders text, lines, references, helper copy, focus state, and external value updates', () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <TemplateEditor {...props} value={'Start\n{{nodes.collect.output.title}}\nEnd'} onChange={onChange} />,
    );
    const editor = screen.getByRole('textbox', { name: props.label });
    expect(editor).toHaveTextContent('StartCollect data · titleEnd');
    expect(editor.querySelectorAll('br')).toHaveLength(2);
    expect(editor.querySelector('[data-template-ref="nodes.collect.output.title"]')).toHaveAttribute('contenteditable', 'false');
    expect(screen.getByText(props.helperText)).toBeVisible();
    expect(editor).toHaveStyle({ minHeight: '140px' });

    fireEvent.focus(editor);
    fireEvent.blur(editor);
    rerender(<TemplateEditor {...props} sources={[...sources]} value={'Updated {{trigger.type}}'} onChange={onChange} />);
    expect(editor).toHaveTextContent('Updated Trigger · type');
    rerender(<TemplateEditor {...props} placeholder={undefined} value={'Updated {{trigger.type}}'} onChange={onChange} />);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('serializes browser-created text, blocks, line breaks, pills, and ignored nodes', () => {
    const onChange = vi.fn();
    render(<TemplateEditor {...props} value="" onChange={onChange} />);
    const editor = screen.getByRole('textbox', { name: props.label });
    editor.append(
      document.createTextNode('Hello'),
      document.createElement('br'),
      Object.assign(document.createElement('div'), { textContent: 'World' }),
      Object.assign(document.createElement('p'), { innerHTML: '<span data-template-ref="trigger.firedAt">ignored</span>' }),
      document.createComment('ignored'),
    );
    fireEvent.input(editor);
    expect(onChange).toHaveBeenLastCalledWith('Hello\nWorld\n{{trigger.firedAt}}');
  });

  it('opens filtered autocomplete at the caret and inserts selections by mouse and keyboard', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<TemplateEditor {...props} value="" onChange={onChange} />);
    const editor = screen.getByRole('textbox', { name: props.label });

    editor.textContent = 'Send {{tit';
    placeCaret(editor.firstChild as Text, editor.textContent.length);
    fireEvent.input(editor);
    expect(screen.getByRole('menuitem', { name: /title/ })).toBeVisible();
    fireEvent.mouseDown(screen.getByRole('menuitem', { name: /title/ }));
    expect(onChange).toHaveBeenLastCalledWith(`Send {{nodes.collect.output.title}}\u00a0`);
    expect(editor.querySelector('[data-template-ref="nodes.collect.output.title"]')).toBeTruthy();

    editor.textContent = '{{trigger';
    placeCaret(editor.firstChild as Text, editor.textContent.length);
    fireEvent.input(editor);
    fireEvent.keyDown(editor, { key: 'ArrowDown' });
    fireEvent.keyDown(editor, { key: 'ArrowUp' });
    fireEvent.keyDown(editor, { key: 'Enter' });
    expect(onChange).toHaveBeenLastCalledWith(expect.stringMatching(/^\{\{trigger\.(type|firedAt)\}\}/));

    editor.textContent = '{{item';
    placeCaret(editor.firstChild as Text, editor.textContent.length);
    fireEvent.input(editor);
    fireEvent.keyDown(editor, { key: 'Tab' });
    expect(onChange).toHaveBeenLastCalledWith(expect.stringMatching(/^\{\{item/));

    editor.textContent = '{{does-not-match';
    placeCaret(editor.firstChild as Text, editor.textContent.length);
    fireEvent.input(editor);
    expect(screen.queryByRole('menuitem')).not.toBeInTheDocument();
    await user.keyboard('{Escape}');
  });

  it('updates suggestions on navigation keys, closes them, and handles invalid caret states', () => {
    const onChange = vi.fn();
    render(<TemplateEditor {...props} value="" onChange={onChange} />);
    const editor = screen.getByRole('textbox', { name: props.label });
    editor.textContent = '{{';
    placeCaret(editor.firstChild as Text, 2);
    fireEvent.input(editor);
    expect(screen.getAllByRole('menuitem').length).toBeGreaterThan(1);
    fireEvent.keyUp(editor, { key: 'ArrowLeft' });
    fireEvent.keyUp(editor, { key: 'x' });
    fireEvent.keyDown(editor, { key: 'x' });
    fireEvent.keyDown(editor, { key: 'Escape' });
    expect(screen.queryByRole('menuitem')).not.toBeInTheDocument();
    fireEvent.keyDown(editor, { key: 'Enter' });

    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    selection?.removeAllRanges();
    selection?.addRange(range);
    fireEvent.input(editor);

    placeCaret(editor, 0);
    fireEvent.input(editor);
    editor.textContent = '{{';
    placeCaret(editor.firstChild as Text, 2);
    fireEvent.input(editor);
    editor.textContent = 'plain text';
    placeCaret(editor.firstChild as Text, editor.textContent.length);
    fireEvent.mouseDown(screen.getAllByRole('menuitem')[0]);

    editor.textContent = '{{';
    placeCaret(editor.firstChild as Text, 2);
    fireEvent.input(editor);
    const outside = document.createTextNode('{{outside');
    document.body.append(outside);
    placeCaret(outside, outside.textContent?.length ?? 0);
    fireEvent.mouseDown(screen.getAllByRole('menuitem')[0]);
    fireEvent.input(editor);
    expect(onChange).toHaveBeenCalled();
    outside.remove();
  });

  it('keeps keyboard selection safe when the available options change or become empty', () => {
    const onChange = vi.fn();
    const { rerender } = render(<TemplateEditor {...props} value="" onChange={onChange} />);
    const editor = screen.getByRole('textbox', { name: props.label });
    editor.textContent = '{{';
    placeCaret(editor.firstChild as Text, 2);
    fireEvent.input(editor);
    fireEvent.keyDown(editor, { key: 'ArrowDown' });
    fireEvent.keyDown(editor, { key: 'ArrowDown' });
    fireEvent.keyDown(editor, { key: 'ArrowDown' });
    rerender(<TemplateEditor {...props} sources={[]} value="" onChange={onChange} />);
    fireEvent.keyDown(editor, { key: 'Enter' });
    expect(onChange).toHaveBeenLastCalledWith('');

    editor.textContent = '{{no-match';
    placeCaret(editor.firstChild as Text, editor.textContent.length);
    fireEvent.input(editor);
    fireEvent.keyDown(editor, { key: 'Enter' });
    expect(editor).toHaveTextContent('{{no-match');
    fireEvent.keyDown(editor, { key: 'Escape' });
  });

  it('pastes plain text, displays both theme palettes, limits large menus, and closes after blur', () => {
    vi.useFakeTimers();
    const execCommand = vi.fn();
    Object.defineProperty(document, 'execCommand', { configurable: true, value: execCommand });
    const manySources: TemplateSourceNode[] = [{
      nodeId: 'many', nodeName: 'Many fields',
      fields: Array.from({ length: 40 }, (_, index) => ({ path: `field${index}`, sample: index % 2 ? `value${index}` : { index } })),
    }];
    const { unmount } = render(
      <ThemeProvider theme={createTheme({ palette: { mode: 'dark' } })}>
        <TemplateEditor {...props} helperText={undefined} placeholder={'A "quoted" value'} sources={manySources} value="" onChange={vi.fn()} />
      </ThemeProvider>,
    );
    const editor = screen.getByRole('textbox', { name: props.label });
    fireEvent.paste(editor, { clipboardData: { getData: vi.fn().mockReturnValue('safe text') } });
    expect(execCommand).toHaveBeenCalledWith('insertText', false, 'safe text');

    editor.textContent = '{{';
    placeCaret(editor.firstChild as Text, 2);
    fireEvent.input(editor);
    expect(screen.getAllByRole('menuitem')).toHaveLength(30);
    expect(screen.getByText('value1')).toBeVisible();
    expect(screen.getByText('{"index":2}')).toBeVisible();
    fireEvent.blur(editor);
    act(() => vi.advanceTimersByTime(150));
    expect(screen.queryByRole('menuitem')).not.toBeInTheDocument();
    unmount();
    vi.useRealTimers();
  });
});
