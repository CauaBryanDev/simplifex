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

export async function recuperarSenha(email) {
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: `${window.location.origin}/redefinir-senha.html`,
  });
  if (error) throw error;
}
