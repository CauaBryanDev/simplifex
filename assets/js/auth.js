import { supabase } from './supabaseClient.js';

/** Cadastra novo usuário e cria o profile inicial (via trigger no banco). */
export async function cadastrar({ email, senha, nomeCompleto, cnpj, regimeTributario, uf, municipio }) {
  const { data, error } = await supabase.auth.signUp({
    email,
    password: senha,
    options: { data: { nome_completo: nomeCompleto } },
  });
  if (error) throw error;

  // Completa o profile com dados fiscais (o trigger já criou a linha com o nome)
  if (data.user) {
    const { error: profileError } = await supabase
      .from('profiles')
      .update({ cnpj, regime_tributario: regimeTributario, uf, municipio })
      .eq('id', data.user.id);
    if (profileError) console.warn('Perfil criado, mas houve erro ao salvar dados fiscais:', profileError.message);
  }
  return data;
}

export async function entrar({ email, senha }) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password: senha });
  if (error) throw error;
  return data;
}

export async function sair() {
  await supabase.auth.signOut();
  window.location.href = '/login.html';
}

export async function usuarioAtual() {
  const { data: { user } } = await supabase.auth.getUser();
  return user;
}

export async function perfilAtual() {
  const user = await usuarioAtual();
  if (!user) return null;
  const { data, error } = await supabase.from('profiles').select('*').eq('id', user.id).single();
  if (error) { console.error(error); return null; }
  return data;
}

/** Protege páginas internas: redireciona para /login.html se não houver sessão. */
export async function exigirSessao() {
  const user = await usuarioAtual();
  if (!user) {
    window.location.href = '/login.html';
    return null;
  }
  return user;
}

/**
 * Retorna a assinatura ativa (status = 'authorized') do usuário logado, ou
 * null se ele não tiver nenhuma. Usado para liberar/bloquear o painel
 * (fluxo de caixa) e para aplicar o limite de transações de cada plano.
 */
export async function assinaturaAtiva() {
  const { data, error } = await supabase.rpc('assinatura_ativa');
  if (error) { console.error(error); return null; }
  return Array.isArray(data) ? (data[0] || null) : (data || null);
}

/** true se o usuário logado tem assinatura ativa (pode usar o painel/fluxo de caixa). */
export async function temAcessoAtivo() {
  const { data, error } = await supabase.rpc('usuario_tem_acesso');
  if (error) { console.error(error); return false; }
  return !!data;
}

/**
 * Ajusta a navegação de páginas PÚBLICAS (index.html, calculadora.html) de
 * acordo com a sessão atual — sem nunca redirecionar nem deslogar ninguém.
 * A sessão do Supabase já fica salva no localStorage do navegador e continua
 * válida ao navegar entre páginas; isso aqui só corrige o que aparece no menu,
 * para não parecer que o usuário "caiu" da conta ao visitar Início/Simulador.
 *
 * Marque no HTML:
 *   <a href="/login.html" data-nav="deslogado">Entrar</a>
 *   <a href="/cadastro.html" data-nav="deslogado">Criar conta</a>
 *   <a href="/dashboard.html" data-nav="logado" style="display:none;">Painel</a>
 *   <a href="#" data-nav="logado" data-acao="sair" style="display:none;">Sair</a>
 */
export async function atualizarNavSessao() {
  const user = await usuarioAtual();
  document.querySelectorAll('[data-nav="logado"]').forEach(el => {
    el.style.display = user ? '' : 'none';
  });
  document.querySelectorAll('[data-nav="deslogado"]').forEach(el => {
    el.style.display = user ? 'none' : '';
  });
  document.querySelectorAll('[data-acao="sair"]').forEach(el => {
    el.addEventListener('click', (ev) => { ev.preventDefault(); sair(); });
  });
}

export async function recuperarSenha(email) {
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: `${window.location.origin}/redefinir-senha.html`,
  });
  if (error) throw error;
}
