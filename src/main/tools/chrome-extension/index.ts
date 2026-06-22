import type {
  CallOfficialToolInput,
  CallOfficialToolResult,
  OfficialToolDefinition,
  ToolMutationResult,
} from '../../../shared/types';
import { getSharedCopy } from '../../../shared/i18n';
import type { InternalToolContext, InternalToolModule } from '../types';
import { ChromeExtensionBridgeManager } from './manager';
import {
  CHROME_EXTENSION_NATIVE_HOST_NAME,
  CHROME_EXTENSION_TOOL_ID,
  type ChromeExtensionCommandResponse,
} from './types';

const ACTION_PREFIX = `${CHROME_EXTENSION_TOOL_ID}.`;

const definition: OfficialToolDefinition = {
  id: CHROME_EXTENSION_TOOL_ID,
  name: 'Forger Chrome Extension',
  description: 'Operates a dedicated Chrome window through the Forger Chrome extension and a local native bridge.',
  version: '0.1.0',
  runtime: 'builtin',
  official: true,
  secrets: [],
  actions: [
    {
      id: `${ACTION_PREFIX}connection.status`,
      name: 'Connection status',
      description: 'Checks whether the Forger Chrome extension is connected.',
      risk: 'low',
    },
    {
      id: `${ACTION_PREFIX}open_dedicated_tab`,
      name: 'Open dedicated tab',
      description: 'Creates a dedicated Chrome window and tab controlled by Forger.',
      risk: 'medium',
    },
    {
      id: `${ACTION_PREFIX}get_current_url`,
      name: 'Get current URL',
      description: 'Reads the current URL of a dedicated Chrome session.',
      risk: 'low',
    },
    {
      id: `${ACTION_PREFIX}navigate`,
      name: 'Navigate',
      description: 'Navigates a dedicated Chrome session to an http or https URL.',
      risk: 'medium',
    },
    {
      id: `${ACTION_PREFIX}get_html`,
      name: 'Get HTML',
      description: 'Reads page HTML from the full page or from a selector.',
      risk: 'high',
    },
    {
      id: `${ACTION_PREFIX}click`,
      name: 'Click element',
      description: 'Clicks an element matched by selector.',
      risk: 'medium',
    },
    {
      id: `${ACTION_PREFIX}focus`,
      name: 'Focus element',
      description: 'Focuses an element matched by selector.',
      risk: 'medium',
    },
    {
      id: `${ACTION_PREFIX}hover`,
      name: 'Hover element',
      description: 'Dispatches hover events for an element matched by selector.',
      risk: 'medium',
    },
    {
      id: `${ACTION_PREFIX}input_text`,
      name: 'Input text',
      description: 'Writes text into an input or contenteditable element matched by selector.',
      risk: 'high',
    },
    {
      id: `${ACTION_PREFIX}submit_form`,
      name: 'Submit form',
      description: 'Submits the form associated with an element matched by selector.',
      risk: 'high',
    },
    {
      id: `${ACTION_PREFIX}get_styles`,
      name: 'Get styles',
      description: 'Reads computed and inline CSS styles from an element matched by selector.',
      risk: 'low',
    },
    {
      id: `${ACTION_PREFIX}set_styles`,
      name: 'Set styles',
      description: 'Applies allowed CSS styles to an element matched by selector.',
      risk: 'medium',
    },
    {
      id: `${ACTION_PREFIX}close_session`,
      name: 'Close session',
      description: 'Closes a dedicated Chrome window controlled by Forger.',
      risk: 'medium',
    },
  ],
  changelog: ['Dev MVP for a local Chrome extension bridge and dedicated browser sessions.'],
};

let manager: ChromeExtensionBridgeManager | null = null;

const getManager = (): ChromeExtensionBridgeManager => {
  manager ??= new ChromeExtensionBridgeManager();
  return manager;
};

const configure = async (context: InternalToolContext): Promise<ToolMutationResult> => {
  const copy = getSharedCopy(context.locale);
  try {
    const status = await getManager().configure(context);
    return {
      success: true,
      userMessage: status.connected ? copy.tools.chromeExtensionConnected : copy.tools.chromeExtensionWaiting,
    };
  } catch (error) {
    return {
      success: false,
      userMessage: copy.tools.chromeExtensionConfigureFailed,
      technicalCode: error instanceof Error ? error.message : 'chrome_extension_configure_failed',
    };
  }
};

const toToolResult = (response: ChromeExtensionCommandResponse, fallbackCode: string, fallbackMessage: string): CallOfficialToolResult => {
  if (response.success) {
    return { success: true, data: response.data };
  }
  return {
    success: false,
    userMessage: response.error?.message ?? fallbackMessage,
    technicalCode: response.error?.code ?? fallbackCode,
  };
};

const execute = async (
  input: CallOfficialToolInput,
  context: InternalToolContext,
): Promise<CallOfficialToolResult> => {
  const toolManager = getManager();
  try {
    if (input.actionId === `${ACTION_PREFIX}connection.status`) {
      return { success: true, data: await toolManager.status(context) };
    }
    if (input.actionId === `${ACTION_PREFIX}open_dedicated_tab`) {
      const parsed = toolManager.parseOpenDedicatedTabInput(input.input);
      if (!parsed) {
        return { success: false, userMessage: 'Indica una URL http o https valida.', technicalCode: 'chrome_extension_open_input_invalid' };
      }
      return toToolResult(await toolManager.sendCommand(context, 'open_dedicated_tab', parsed), 'chrome_extension_open_failed', 'No pudimos abrir Chrome.');
    }
    if (input.actionId === `${ACTION_PREFIX}get_current_url`) {
      const parsed = toolManager.parseSessionInput(input.input);
      if (!parsed) {
        return { success: false, userMessage: 'Indica la sesion de Chrome que quieres revisar.', technicalCode: 'chrome_extension_session_input_invalid' };
      }
      return toToolResult(await toolManager.sendCommand(context, 'get_current_url', parsed), 'chrome_extension_url_failed', 'No pudimos leer la URL de Chrome.');
    }
    if (input.actionId === `${ACTION_PREFIX}navigate`) {
      const parsed = toolManager.parseNavigateInput(input.input);
      if (!parsed) {
        return { success: false, userMessage: 'Indica la sesion y una URL http o https valida.', technicalCode: 'chrome_extension_navigate_input_invalid' };
      }
      return toToolResult(await toolManager.sendCommand(context, 'navigate', parsed), 'chrome_extension_navigate_failed', 'No pudimos navegar en Chrome.');
    }
    if (input.actionId === `${ACTION_PREFIX}get_html`) {
      const parsed = toolManager.parseSelectorInput(input.input, { allowMissingSelector: true });
      if (!parsed) {
        return { success: false, userMessage: 'Indica la sesion de Chrome que quieres leer.', technicalCode: 'chrome_extension_html_input_invalid' };
      }
      return toToolResult(await toolManager.sendCommand(context, 'get_html', parsed), 'chrome_extension_html_failed', 'No pudimos leer la pagina.');
    }
    if (input.actionId === `${ACTION_PREFIX}click` || input.actionId === `${ACTION_PREFIX}focus` || input.actionId === `${ACTION_PREFIX}hover`) {
      const action = input.actionId.slice(ACTION_PREFIX.length);
      const parsed = toolManager.parseSelectorInput(input.input);
      if (!parsed) {
        return { success: false, userMessage: 'Indica la sesion y el selector del elemento.', technicalCode: 'chrome_extension_selector_input_invalid' };
      }
      return toToolResult(await toolManager.sendCommand(context, action, parsed), `chrome_extension_${action}_failed`, 'No pudimos operar ese elemento.');
    }
    if (input.actionId === `${ACTION_PREFIX}input_text`) {
      const parsed = toolManager.parseSelectorInput(input.input, { includeText: true });
      if (!parsed) {
        return { success: false, userMessage: 'Indica la sesion, el selector y el texto.', technicalCode: 'chrome_extension_input_text_invalid' };
      }
      return toToolResult(await toolManager.sendCommand(context, 'input_text', parsed), 'chrome_extension_input_failed', 'No pudimos escribir en ese elemento.');
    }
    if (input.actionId === `${ACTION_PREFIX}submit_form`) {
      const parsed = toolManager.parseSubmitFormInput(input.input);
      if (!parsed) {
        return { success: false, userMessage: 'Indica la sesion y el selector del formulario o de un elemento dentro del formulario.', technicalCode: 'chrome_extension_submit_form_invalid' };
      }
      return toToolResult(await toolManager.sendCommand(context, 'submit_form', parsed), 'chrome_extension_submit_form_failed', 'No pudimos enviar ese formulario.');
    }
    if (input.actionId === `${ACTION_PREFIX}get_styles`) {
      const parsed = toolManager.parseStylesInput(input.input, { includeStyles: false });
      if (!parsed) {
        return { success: false, userMessage: 'Indica la sesion y el selector del elemento.', technicalCode: 'chrome_extension_get_styles_invalid' };
      }
      return toToolResult(await toolManager.sendCommand(context, 'get_styles', parsed), 'chrome_extension_get_styles_failed', 'No pudimos leer los estilos de ese elemento.');
    }
    if (input.actionId === `${ACTION_PREFIX}set_styles`) {
      const parsed = toolManager.parseStylesInput(input.input, { includeStyles: true });
      if (!parsed) {
        return { success: false, userMessage: 'Indica la sesion, el selector y los estilos permitidos.', technicalCode: 'chrome_extension_set_styles_invalid' };
      }
      return toToolResult(await toolManager.sendCommand(context, 'set_styles', parsed), 'chrome_extension_set_styles_failed', 'No pudimos aplicar esos estilos.');
    }
    if (input.actionId === `${ACTION_PREFIX}close_session`) {
      const parsed = toolManager.parseSessionInput(input.input);
      if (!parsed) {
        return { success: false, userMessage: 'Indica la sesion de Chrome que quieres cerrar.', technicalCode: 'chrome_extension_close_input_invalid' };
      }
      return toToolResult(await toolManager.sendCommand(context, 'close_session', parsed), 'chrome_extension_close_failed', 'No pudimos cerrar la sesion de Chrome.');
    }
    return { success: false, userMessage: 'La accion de Chrome no esta disponible.', technicalCode: 'chrome_extension_action_unknown' };
  } catch (error) {
    return {
      success: false,
      userMessage: 'No pudimos completar la accion de Chrome.',
      technicalCode: error instanceof Error ? error.message : 'chrome_extension_action_failed',
    };
  }
};

export const chromeExtensionToolModule: InternalToolModule = {
  definition,
  configure,
  execute,
  isConfigured: async (context) => await getManager().isConfigured(context),
  start: async (context) => {
    await getManager().start(context);
  },
  stop: async () => {
    await manager?.stop();
  },
  deactivate: async () => {
    await manager?.stop();
    manager = null;
  },
};

export const __resetChromeExtensionToolForTests = async (): Promise<void> => {
  await manager?.stop();
  manager = null;
};

export { CHROME_EXTENSION_NATIVE_HOST_NAME };
