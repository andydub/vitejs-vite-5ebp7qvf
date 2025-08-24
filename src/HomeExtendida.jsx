
import { useState } from "react";

const eventosSimulados = [
  { nombre: "🔥 Juntemos gente para que venga Damas Gratis", progreso: 0.75 },
  { nombre: "💃 Que se vuelvan a reunir las Bandana!!!!!", progreso: 0.42 },
  { nombre: "🎸 Fogón con covers de La Renga en la plaza", progreso: 0.88 },
  { nombre: "🪩 Cumbia retro con sonido profesional", progreso: 0.6 },
];

const dias = Array.from({ length: 30 }, (_, i) => i + 1);
const disponibilidadSimulada = {
  2: 5,
  5: 8,
  6: 2,
  10: 9,
  14: 4,
  20: 7,
  21: 1,
  25: 6,
};

export default function HomeExtendida() {
  const [diasSeleccionados, setDiasSeleccionados] = useState([]);

  const toggleDia = (dia) => {
    setDiasSeleccionados((prev) =>
      prev.includes(dia) ? prev.filter((d) => d !== dia) : [...prev, dia]
    );
  };

  const intensidad = (valor) => {
    if (valor >= 8) return "bg-green-400";
    if (valor >= 5) return "bg-yellow-400";
    if (valor >= 2) return "bg-orange-400";
    return "bg-zinc-700";
  };

  return (
    <section className="mt-12 space-y-10">
      <div>
        <h2 className="text-xl font-bold mb-4">📅 ¿Cuándo podés?</h2>
        <div className="grid grid-cols-7 gap-2">
          {dias.map((dia) => (
            <div
              key={dia}
              onClick={() => toggleDia(dia)}
              className={\`w-10 h-10 flex items-center justify-center rounded cursor-pointer 
                \${diasSeleccionados.includes(dia) ? 'ring-2 ring-white' : ''}
                \${intensidad(disponibilidadSimulada[dia] || 0)}\`}
            >
              {dia}
            </div>
          ))}
        </div>
        <p className="text-xs text-zinc-400 mt-2">Tocá los días que podrías sumarte</p>
      </div>

      <div>
        <h2 className="text-xl font-bold mb-4">🔥 Otros eventos que se están armando</h2>
        <div className="grid gap-4">
          {eventosSimulados.map((evento, idx) => (
            <div key={idx} className="bg-zinc-800 rounded p-4 border border-zinc-700 space-y-2">
              <div className="text-lg font-semibold text-amber-300">{evento.nombre}</div>
              <div className="w-full bg-zinc-700 h-4 rounded-full overflow-hidden">
                <div
                  className="h-full transition-all"
                  style={{
                    width: \`\${evento.progreso * 100}%\`,
                    background: \`linear-gradient(to right, orange, gold, limegreen)\`,
                  }}
                ></div>
              </div>
              <p className="text-sm text-zinc-400">
                {Math.round(evento.progreso * 100)}% confirmado
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
