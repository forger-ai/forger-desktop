import { describe, expect, it } from 'vitest';
import { collaborationError } from '@renderer/views/connections/repositoryCollaborationUi';
import {
  enRepositoryCollaboration,
  esRepositoryCollaboration,
} from '@renderer/i18n/locales/repositoryCollaboration';

describe('repository folder recovery guidance', () => {
  it.each([
    'La carpeta seleccionada no es un repositorio Git disponible.',
    'Selecciona una carpeta de proyecto válida.',
  ])(
    'translates the safe folder rejection %s, including the Electron envelope',
    (message) => {
      for (const copy of [
        enRepositoryCollaboration,
        esRepositoryCollaboration,
      ]) {
        expect(collaborationError(new Error(message), copy)).toBe(
          copy.invalidRepository,
        );
        expect(
          collaborationError(
            new Error(
              `Error invoking remote method 'forger:repository-collaboration:add-repository': Error: ${message}`,
            ),
            copy,
          ),
        ).toBe(copy.invalidRepository);
      }
    },
  );

  it('does not expose or classify arbitrary details appended to a recognized message', () => {
    const error = new Error(
      'La carpeta seleccionada no es un repositorio Git disponible. /private/hidden',
    );
    expect(collaborationError(error, enRepositoryCollaboration)).toBe(
      enRepositoryCollaboration.actionError,
    );
  });
});
