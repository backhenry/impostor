// Banco de palavras mockado, organizado por categoria.
// Em produção, isso poderia vir de um banco de dados ou API.

const WORD_BANK = {
  Animais: [
    'Elefante', 'Pinguim', 'Tubarão', 'Coruja', 'Camaleão',
    'Golfinho', 'Canguru', 'Jacaré', 'Borboleta', 'Lobo',
  ],
  Profissões: [
    'Bombeiro', 'Dentista', 'Astronauta', 'Chef de Cozinha', 'Juiz',
    'Piloto', 'Veterinário', 'Arquiteto', 'Palhaço', 'Detetive',
  ],
  Objetos: [
    'Guarda-chuva', 'Violão', 'Telescópio', 'Bússola', 'Martelo',
    'Espelho', 'Mochila', 'Abajur', 'Tesoura', 'Relógio',
  ],
  Comidas: [
    'Feijoada', 'Pipoca', 'Sushi', 'Brigadeiro', 'Churrasco',
    'Lasanha', 'Açaí', 'Coxinha', 'Sorvete', 'Tapioca',
  ],
  Lugares: [
    'Praia', 'Hospital', 'Circo', 'Biblioteca', 'Aeroporto',
    'Cachoeira', 'Estádio', 'Museu', 'Fazenda', 'Shopping',
  ],
};

/**
 * Sorteia uma categoria e uma palavra dentro dela.
 * @returns {{ category: string, word: string }}
 */
function drawWord() {
  const categories = Object.keys(WORD_BANK);
  const category = categories[Math.floor(Math.random() * categories.length)];
  const words = WORD_BANK[category];
  const word = words[Math.floor(Math.random() * words.length)];
  return { category, word };
}

module.exports = { WORD_BANK, drawWord };
