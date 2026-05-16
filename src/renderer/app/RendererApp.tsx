import { RendererAppView } from '@renderer/app/RendererAppView';
import { useRendererAppController } from '@renderer/app/RendererAppController';

function RendererApp() {
  const controller = useRendererAppController();
  return <RendererAppView controller={controller} />;
}

export default RendererApp;
