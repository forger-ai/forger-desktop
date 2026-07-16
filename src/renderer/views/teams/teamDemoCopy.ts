import type { Locale } from '@renderer/i18n';

const copy = {
  es: {
    title: 'Forger Teams',
    moreDescription: 'Apps, agentes y recursos compartidos para tu organización.',
    eyebrow: 'Beta privada',
    heading: 'Construye y opera apps con tu equipo',
    body: 'Forger Teams reúne apps, agentes, workflows y recursos compartidos en un espacio privado para tu organización.',
    capabilities: [
      ['Trabajo compartido', 'Publica apps y backends internos para que tu equipo trabaje sobre versiones coordinadas.'],
      ['Acceso controlado', 'Administra quién puede usar apps, conexiones, secretos y bases de datos del equipo.'],
      ['Tu espacio personal se mantiene', 'Tus apps y datos personales continúan separados; Teams se suma como un espacio opcional.'],
    ],
    formTitle: 'Solicita una demo',
    formBody: 'Cuéntanos qué quieres construir. Te contactaremos para revisar el acceso con tu equipo.',
    name: 'Nombre',
    email: 'Email de trabajo',
    phone: 'Teléfono',
    useCase: '¿Qué quieres construir con tu equipo?',
    submit: 'Solicitar demo',
    submitting: 'Enviando…',
    success: 'Recibimos tu solicitud. Te contactaremos pronto.',
    error: 'No pudimos enviar tu solicitud. Intenta nuevamente.',
  },
  en: {
    title: 'Forger Teams',
    moreDescription: 'Shared apps, agents, and resources for your organization.',
    eyebrow: 'Private beta',
    heading: 'Build and operate apps with your team',
    body: 'Forger Teams brings apps, agents, workflows, and shared resources into one private workspace for your organization.',
    capabilities: [
      ['Shared work', 'Publish internal apps and backends so your team can work from coordinated versions.'],
      ['Controlled access', 'Manage who can use team apps, connections, secrets, and databases.'],
      ['Your personal space stays personal', 'Your personal apps and data remain separate; Teams is an optional workspace.'],
    ],
    formTitle: 'Request a demo',
    formBody: 'Tell us what you want to build. We will contact you to review access with your team.',
    name: 'Name',
    email: 'Work email',
    phone: 'Phone',
    useCase: 'What do you want to build with your team?',
    submit: 'Request demo',
    submitting: 'Sending…',
    success: 'We received your request. We will contact you soon.',
    error: 'We could not send your request. Please try again.',
  },
} as const;

export const getTeamDemoCopy = (locale: Locale) => copy[locale];
