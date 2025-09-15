
import React, { useState, useCallback, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { GoogleGenAI, Type, Modality } from "@google/genai";

// --- State Management and Types ---
type PublicPage = string;

type CatDetails = {
  size: string;
  age: string;
};

type AppState = {
  isAuthenticated: boolean;
  page: 'public' | 'private';
  publicPage: PublicPage;
  designStep: number;
  selectedSpace: string | null;
  uploadedImages: File[];
  uploadedImageBase64s: string[];
  aiResponse: AIResponse | null;
  editedImageBase64: string | null;
  isLoading: boolean;
  error: string | null;
  numberOfCats: number;
  cats: CatDetails[];
};

type AIResponse = {
  dimensions: string;
  floorPlan: string;
  currentStyle: string;
  suggestions: { styleName: string; description: string }[];
};

type ServiceExample = {
  imgSrc: string;
  title: string;
  description: string;
};

type InspirationTip = {
  title: string;
  description: string;
  imageUrl: string;
};

// --- Utilities ---
const sanitizeSVG = (svgString: string): string => {
  // Basic sanitizer to prevent XSS. Removes script tags and on* event handlers.
  // For production, a more robust library like DOMPurify is recommended.
  return svgString
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/ on\w+="[^"]*"/g, '');
};

// Initialize the API client once to improve performance
const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

// --- Main App Component ---
const App = () => {
  const [state, setState] = useState<AppState>({
    isAuthenticated: false,
    page: 'public',
    publicPage: 'home',
    designStep: 0,
    selectedSpace: null,
    uploadedImages: [],
    uploadedImageBase64s: [],
    aiResponse: null,
    editedImageBase64: null,
    isLoading: false,
    error: null,
    numberOfCats: 1,
    cats: [{ size: '', age: '' }],
  });

  const handleLogin = useCallback(() => {
    setState(s => ({ ...s, isAuthenticated: true, page: 'private', designStep: 1 }));
  }, []);
  
  const handleNavigate = useCallback((targetPage: PublicPage) => {
    setState(s => ({ ...s, page: 'public', publicPage: targetPage }));
  }, []);

  const handleSelectSpace = useCallback((space: string) => {
    // Always advance to the next step sequentially
    setState(s => ({ ...s, selectedSpace: space, designStep: s.designStep + 1 }));
  }, []);

  const handleCatDetailsSubmit = useCallback((cats: CatDetails[]) => {
    // Advance to the next step after submitting cat details
    setState(s => ({ ...s, cats, designStep: s.designStep + 1 }));
  }, []);
  
  const handleFileChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (files && files.length > 0) {
      const fileArray = Array.from(files);
      const filePromises = fileArray.map(file => {
        return new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onloadend = () => {
            resolve((reader.result as string).split(',')[1]);
          };
          reader.onerror = reject;
          reader.readAsDataURL(file);
        });
      });

      Promise.all(filePromises)
        .then(base64s => {
          setState(s => ({
            ...s,
            uploadedImages: fileArray,
            uploadedImageBase64s: base64s,
            error: null,
          }));
        })
        .catch(() => {
          setState(s => ({ ...s, error: "Error al leer uno o más archivos." }));
        });
    }
  }, []);

  const handleAnalyzeSpace = useCallback(async () => {
    if (state.uploadedImageBase64s.length === 0) {
      setState(s => ({...s, error: 'Por favor, sube al menos una imagen de tu espacio.'}));
      return;
    }
    setState(s => ({...s, isLoading: true, error: null, aiResponse: null }));
    
    try {
      const imageParts = state.uploadedImageBase64s.map((base64, index) => ({
        inlineData: {
          mimeType: state.uploadedImages[index]!.type,
          data: base64,
        },
      }));
      
      const shouldValidate = state.selectedSpace !== 'Sala' && state.selectedSpace !== 'Espacio para Gatos';

      if (shouldValidate) {
        // Step 1: Conditional Validation
        const validationPrompt = {
          text: `Eres un experto en análisis de imágenes. Valida las siguientes imágenes. Primero, verifica que todas las imágenes son del mismo espacio o habitación. Segundo, verifica que el tipo de espacio en las imágenes coincide con el tipo de espacio seleccionado: '${state.selectedSpace}'. Responde únicamente con JSON.`
        };

        const validationResponse = await ai.models.generateContent({
          model: 'gemini-2.5-flash',
          contents: { parts: [...imageParts, validationPrompt] },
          config: {
            responseMimeType: "application/json",
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                areImagesConsistent: { type: Type.BOOLEAN },
                isSpaceTypeCorrect: { type: Type.BOOLEAN }
              }
            }
          }
        });
        
        // FIX: The .text property on the response is a string, not a function.
        // It should be accessed directly.
        const validationResult = JSON.parse(validationResponse.text);
        
        if (!validationResult.areImagesConsistent || !validationResult.isSpaceTypeCorrect) {
            setState(s => ({
                ...s,
                isLoading: false,
                error: 'Validación fallida: Las imágenes no parecen ser del mismo espacio o no coinciden con el tipo de habitación seleccionado. Por favor, verifica tus fotos.'
            }));
            return;
        }
      }
      
      // Step 2: Proceed to detailed analysis if validation passes
      let catDetailsPrompt = '';
      if (state.selectedSpace === 'Espacio para Gatos') {
        catDetailsPrompt = `\nAdemás, considera la siguiente información sobre los ${state.cats.length} gatos que usarán el espacio: \n`;
        state.cats.forEach((cat, index) => {
          catDetailsPrompt += `- Gato ${index + 1}: tamaño ${cat.size}, edad ${cat.age}. \n`;
        });
        catDetailsPrompt += "Actúa como un experto en enriquecimiento ambiental felino y adapta tus sugerencias a sus necesidades específicas (ej. rampas para gatos mayores, zonas altas de juego para los jóvenes).";
      }
              
      const textPart = {
        text: `Eres un asistente de diseño de interiores experto en mobiliario de madera para un espacio tipo '${state?.selectedSpace}'. 
        Analiza las imágenes proporcionadas, que son diferentes vistas del mismo espacio y ya han sido validadas como correctas. 
        Una de las imágenes contiene un objeto de referencia de escala conocido para que puedas estimar las dimensiones.

        1. Estima las dimensiones principales de la habitación (largo, ancho, alto) en metros.
        2. Genera un plano de planta 2D simple en formato SVG. El SVG debe ser un string XML válido, minimalista, con fondo transparente y trazos negros. No incluyas scripts ni manejadores de eventos.
        3. Describe el estilo actual del espacio.
        4. Ofrece 3 sugerencias de diseño distintas utilizando mobiliario estructural de madera (por ejemplo: estanterías, bibliotecas, gabinetes de cocina o baño, muebles de recibidor). No sugieras muebles exentos como sillas, sofás o mesas de centro.
        5. Presenta tu respuesta en formato JSON. No incluyas \` \`\`\`json \` al inicio ni \` \`\`\` \` al final.

        ${catDetailsPrompt}`
      };

      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: { parts: [...imageParts, textPart] },
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              dimensions: { type: Type.STRING },
              floorPlan: { type: Type.STRING },
              currentStyle: { type: Type.STRING },
              suggestions: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    styleName: { type: Type.STRING },
                    description: { type: Type.STRING }
                  }
                }
              }
            }
          }
        }
      });
      
      // FIX: The .text property on the response is a string, not a function.
      // It should be accessed directly.
      const jsonResponse = JSON.parse(response.text);
      setState(s => ({...s, aiResponse: jsonResponse, designStep: s.designStep + 1, isLoading: false}));

    } catch (e) {
      console.error(e);
      setState(s => ({...s, isLoading: false, error: 'Ocurrió un error al analizar la imagen. Inténtalo de nuevo.'}));
    }
  }, [state.uploadedImageBase64s, state.uploadedImages, state.selectedSpace, state.cats]);

  const handleRefineImage = useCallback(async (prompt: string) => {
    if (state.uploadedImageBase64s.length === 0) {
      setState(s => ({...s, error: 'No hay imagen base para refinar.'}));
      return;
    }
    setState(s => ({...s, isLoading: true, error: null }));

    try {
      // Use the first image as the base for refinement
      const imagePart = {
        inlineData: {
          mimeType: state.uploadedImages[0]!.type,
          data: state.uploadedImageBase64s[0],
        },
      };
      const textPart = { text: prompt };

      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash-image-preview',
        contents: { parts: [imagePart, textPart] },
        config: {
          responseModalities: [Modality.IMAGE, Modality.TEXT],
        },
      });

      let newImageBase64 = null;
      for (const part of response.candidates[0].content.parts) {
        if (part.inlineData) {
          newImageBase64 = part.inlineData.data;
          break; 
        }
      }
      
      if (newImageBase64) {
        setState(s => ({...s, editedImageBase64: newImageBase64, isLoading: false}));
      } else {
        throw new Error("La IA no generó una imagen.");
      }

    } catch (e) {
      console.error(e);
      setState(s => ({...s, isLoading: false, error: 'No se pudo refinar la imagen. Inténtalo con otra instrucción.'}));
    }
  }, [state.uploadedImageBase64s, state.uploadedImages]);

  const handleRequestQuote = useCallback(() => {
    // Always advance to the next step sequentially
    setState(s => ({ ...s, designStep: s.designStep + 1 }));
  }, []);

  const resetJourney = useCallback(() => {
     setState(s => ({
        ...s,
        designStep: 1,
        selectedSpace: null,
        uploadedImages: [],
        uploadedImageBase64s: [],
        aiResponse: null,
        editedImageBase64: null,
        isLoading: false,
        error: null,
        numberOfCats: 1,
        cats: [{ size: '', age: '' }],
    }));
  }, []);

  const handleCatCountChange = (count: number) => {
    const newCats = Array.from({ length: count }, () => ({ size: '', age: '' }));
    setState(s => ({ ...s, numberOfCats: count, cats: newCats }));
  };
  
  const handleCatDetailChange = (index: number, field: 'size' | 'age', value: string) => {
    const newCats = [...state.cats];
    newCats[index][field] = value;
    setState(s => ({ ...s, cats: newCats }));
  };
  
  const handleBack = useCallback(() => {
    // Always go back one step sequentially
    setState(s => ({ ...s, designStep: Math.max(1, s.designStep - 1) }));
  }, []);

  const renderPublicPage = () => {
    const page = state.publicPage;
    const handleBackToServices = () => handleNavigate('services');
    
    if (page.startsWith('services/')) {
        const service = page.split('/')[1];
        const servicePageMap: { [key: string]: React.ReactElement } = {
            'salas': <SalasServicePage onLogin={handleLogin} onBack={handleBackToServices} />,
            'habitacion': <HabitacionServicePage onLogin={handleLogin} onBack={handleBackToServices} />,
            'cocinas': <CocinasServicePage onLogin={handleLogin} onBack={handleBackToServices} />,
            'banos': <BanosServicePage onLogin={handleLogin} onBack={handleBackToServices} />,
            'estudios': <EstudiosServicePage onLogin={handleLogin} onBack={handleBackToServices} />,
            'gatos': <GatosServicePage onLogin={handleLogin} onBack={handleBackToServices} />,
        };
        return servicePageMap[service] || <ServicesPage onNavigate={handleNavigate} />;
    }

    const mainPages: { [key: string]: React.ReactElement } = {
        'home': <HomePage onLogin={handleLogin} ai={ai} />,
        'services': <ServicesPage onNavigate={handleNavigate} />,
        'about': <AboutPage />,
        'contact': <ContactPage />,
    };

    return mainPages[page] || <HomePage onLogin={handleLogin} ai={ai} />;
  };

  return (
    <div id="app-container">
      <Header 
        isAuthenticated={state.isAuthenticated} 
        onNavigate={handleNavigate}
        activePage={state.publicPage}
      />
      <main>
        {state.page === 'public' && renderPublicPage()}
        {state.page === 'private' && (
          <PrivatePage 
            state={state} 
            onSelectSpace={handleSelectSpace}
            onFileChange={handleFileChange}
            onAnalyzeSpace={handleAnalyzeSpace}
            onRefineImage={handleRefineImage}
            onRequestQuote={handleRequestQuote}
            onReset={resetJourney}
            onCatDetailsSubmit={handleCatDetailsSubmit}
            onCatCountChange={handleCatCountChange}
            onCatDetailChange={handleCatDetailChange}
            onBack={handleBack}
          />
        )}
      </main>
      <Footer />
    </div>
  );
};

// --- UI Components ---
const Header = ({ isAuthenticated, onNavigate, activePage }: { 
  isAuthenticated: boolean,
  onNavigate: (page: PublicPage) => void,
  activePage: PublicPage
 }) => (
  <header>
    <button className="logo" type="button" aria-label="Página de inicio" onClick={() => onNavigate('home')}>Maderarte</button>
    <nav>
      <a href="#" className={activePage.startsWith('services') ? 'active' : ''} onClick={(e) => {e.preventDefault(); onNavigate('services')}}>Servicios</a>
      <a href="#" className={activePage === 'about' ? 'active' : ''} onClick={(e) => {e.preventDefault(); onNavigate('about')}}>Nosotros</a>
      <a href="#" className={activePage === 'contact' ? 'active' : ''} onClick={(e) => {e.preventDefault(); onNavigate('contact')}}>Contacto</a>
      {isAuthenticated && <div className="user-avatar"></div>}
    </nav>
  </header>
);

const HomePage = ({ onLogin, ai }: { onLogin: () => void, ai: GoogleGenAI }) => {
  const [inspiration, setInspiration] = useState<InspirationTip[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchInspiration = async () => {
      try {
        setIsLoading(true);
        setError(null);
        const response = await ai.models.generateContent({
          model: 'gemini-2.5-flash',
          contents: 'Actúa como un experto diseñador de interiores. Genera 4 consejos o tendencias de diseño únicas y concisas sobre el uso de la madera en la decoración del hogar. Para cada consejo, proporciona una URL a una imagen relevante y de alta calidad de Unsplash. Presenta tu respuesta en formato JSON. No incluyas "```json" al inicio ni "```" al final.',
          config: {
            responseMimeType: "application/json",
            responseSchema: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  title: { type: Type.STRING },
                  description: { type: Type.STRING },
                  imageUrl: { type: Type.STRING }
                }
              }
            }
          }
        });
        
        const tips = JSON.parse(response.text);
        setInspiration(tips);
      } catch (e) {
        console.error("Error fetching inspiration:", e);
        setError("No se pudo cargar la inspiración en este momento.");
      } finally {
        setIsLoading(false);
      }
    };

    fetchInspiration();
  }, [ai]);

  return (
    <div className="public-page">
      <section className="hero">
        <h1>Transformando Espacios con la Calidez de la Madera</h1>
        <p>Diseño y fabricación de mobiliario arquitectónico a medida. Convierte tu visión en una realidad tangible y duradera.</p>
        <button className="cta-button" onClick={onLogin}>Comienza tu Diseño</button>
      </section>
      <section id="inspiration">
        <h2>Inspiración y Tendencias</h2>
        {isLoading && (
          <div className="inspiration-loader">
            <div className="spinner"></div>
            <p>Cargando inspiración...</p>
          </div>
        )}
        {error && <p className="error-message">{error}</p>}
        {!isLoading && !error && (
            <div className="inspiration-cards">
            {inspiration.map((tip, index) => (
                <div className="inspiration-card" key={index}>
                <img src={tip.imageUrl} alt={tip.title} className="inspiration-image" />
                <div className="inspiration-content">
                    <h4>{tip.title}</h4>
                    <p>{tip.description}</p>
                </div>
                </div>
            ))}
            </div>
        )}
      </section>
    </div>
  );
};

const ServicesPage = ({ onNavigate }: { onNavigate: (page: PublicPage) => void }) => (
  <div className="page-container">
    <div className="page-header">
      <h1>Nuestros Servicios</h1>
      <p>Diseño y artesanía en madera para cada rincón de tu vida.</p>
    </div>
    <div className="page-content">
      <div className="service-detail-card clickable salas-theme" onClick={() => onNavigate('services/salas')}>
         <svg aria-hidden="true" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="service-card-icon"><path d="M20 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v3"/><path d="M2 11h20"/><path d="M4 11v5a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5"/></svg>
         <div>
            <h3>Salas y Estancias</h3>
            <p>El salón es el centro de la vida familiar. Diseñamos centros de entretenimiento, librerías a medida y muebles auxiliares que enriquecen tu espacio de convivencia.</p>
         </div>
      </div>
       <div className="service-detail-card clickable habitacion-theme" onClick={() => onNavigate('services/habitacion')}>
        <svg aria-hidden="true" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="service-card-icon"><path d="M2 12h20v6H2z"/><path d="M2 10V6a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v4H2z"/><path d="M6 8v2"/><path d="M18 8v2"/></svg>
         <div>
            <h3>Habitaciones y Dormitorios</h3>
            <p>Creamos santuarios de descanso con armarios a medida, cabeceros y soluciones de almacenamiento que combinan funcionalidad y serenidad.</p>
         </div>
      </div>
      <div className="service-detail-card clickable cocinas-theme" onClick={() => onNavigate('services/cocinas')}>
        <svg aria-hidden="true" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="service-card-icon"><path d="M21 14H3v6a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-6z"/><path d="M3 14V4a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10"/><path d="M15 8v2"/><path d="M9 8v2"/></svg>
         <div>
            <h3>Cocinas Funcionales</h3>
            <p>Transformamos tu cocina en un espacio de inspiración culinaria con gabinetes, islas y barras diseñadas para maximizar la funcionalidad y reflejar tu estilo.</p>
         </div>
      </div>
      <div className="service-detail-card clickable banos-theme" onClick={() => onNavigate('services/banos')}>
        <svg aria-hidden="true" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="service-card-icon"><path d="M21 10H3v8a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-8z"/><path d="M5 10V7a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v3"/><path d="M7 15v-3"/></svg>
         <div>
            <h3>Baños con Encanto Natural</h3>
            <p>Llevamos la calidez de la madera a tu baño con vanidades a medida y acentos decorativos, utilizando maderas tratadas para una belleza duradera.</p>
         </div>
      </div>
       <div className="service-detail-card clickable estudios-theme" onClick={() => onNavigate('services/estudios')}>
        <svg aria-hidden="true" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="service-card-icon"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>
         <div>
            <h3>Estudios y Oficinas en Casa</h3>
            <p>Creamos entornos de trabajo que fomentan la concentración con escritorios ergonómicos, estanterías inteligentes y soluciones de almacenamiento integradas.</p>
         </div>
      </div>
       <div className="service-detail-card clickable gatos-theme" onClick={() => onNavigate('services/gatos')}>
        <svg aria-hidden="true" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="service-card-icon"><path d="M12 5c.67 0 1.35.09 2 .26 1.78-2 5.03-2.84 6.42-2.08.39.21.61.62.58.97-.02.2-.12.39-.28.52-1.14.93-2.24 2.44-2.65 4.31a9.23 9.23 0 0 1-1.25 4.3-1.001 1.001 0 0 1-1.5-.42 1 1 0 0 0-1.6- .33c-1.22.95-2.64 1.4-4.1 1.4-4.42 0-8-3.58-8-8s3.58-8 8-8c.46 0 .91.04 1.35.12"/></svg>
         <div>
            <h3>Enriquecimiento Ambiental para Gatos</h3>
            <p>Diseñamos estructuras y mobiliario integrado que satisface los instintos naturales de tus felinos, integrándose perfectamente con la decoración de tu hogar.</p>
         </div>
      </div>
    </div>
  </div>
);

const serviceData = {
    salas: {
        title: 'Salas y Estancias',
        slogan: 'El Corazón de tu Hogar, Redefinido en Madera',
        examples: [
            { imgSrc: 'https://images.unsplash.com/photo-1616046229478-9901c5536a45?q=80&w=2070&auto=format&fit=crop', title: 'Centro de Entretenimiento Integrado', description: 'Un diseño limpio que combina almacenamiento y exhibición, convirtiendo tu sala en un cine en casa elegante.'},
            { imgSrc: 'https://images.unsplash.com/photo-1615875605825-5eb9bb5c4245?q=80&w=1964&auto=format&fit=crop', title: 'Estantería de Pared a Techo', description: 'Una biblioteca personal que se convierte en la protagonista del espacio, hecha a medida en madera de nogal.'},
            { imgSrc: 'https://images.unsplash.com/photo-1594455734310-541147d3b514?q=80&w=1974&auto=format&fit=crop', title: 'Mueble Recibidor con Banco', description: 'Funcionalidad y elegancia desde la entrada con un banco y almacenamiento a medida en madera de arce.'},
        ]
    },
    habitacion: {
        title: 'Habitaciones y Dormitorios',
        slogan: 'Tu Santuario Personal, Diseñado para el Descanso',
        examples: [
            { imgSrc: 'https://images.unsplash.com/photo-1616627561957-334259b5b6a7?q=80&w=1964&auto=format&fit=crop', title: 'Armario a Medida de Pared a Pared', description: 'Soluciones de almacenamiento que se integran a la perfección, maximizando el espacio y el orden.'},
            { imgSrc: 'https://images.unsplash.com/photo-1595526114035-0d45ed16433d?q=80&w=1974&auto=format&fit=crop', title: 'Cabecero de Cama con Mesitas Flotantes', description: 'Un diseño minimalista y funcional que crea una sensación de amplitud y modernidad en tu dormitorio.'},
            { imgSrc: 'https://images.unsplash.com/photo-1565530493233-a3a7b62a3651?q=80&w=1974&auto=format&fit=crop', title: 'Banco de Almacenamiento al Pie de la Cama', description: 'Una pieza versátil que ofrece un asiento adicional y un lugar discreto para guardar ropa de cama o zapatos.'},
        ]
    },
    cocinas: {
        title: 'Cocinas Funcionales',
        slogan: 'Donde el Sabor se Encuentra con el Diseño',
        examples: [
            { imgSrc: 'https://images.unsplash.com/photo-1579824218331-ea85d37a1599?q=80&w=1935&auto=format&fit=crop', title: 'Gabinetes de Suelo a Techo', description: 'Maximiza el almacenamiento con gabinetes de roble que ofrecen un look continuo y sofisticado.'},
            { imgSrc: 'https://images.unsplash.com/photo-16260731165038-164b311abd17?q=80&w=1974&auto=format&fit=crop', title: 'Isla Central con Almacenamiento', description: 'El punto de encuentro perfecto para la familia, combinando preparación de alimentos y un espacio social informal.'},
            { imgSrc: 'https://images.unsplash.com/photo-1594393049229-9b1274316b99?q=80&w=1974&auto=format&fit=crop', title: 'Estanterías Abiertas de Madera Natural', description: 'Un toque rústico y moderno para exhibir tu vajilla y añadir carácter a las paredes de tu cocina.'},
        ]
    },
    banos: {
        title: 'Baños con Encanto Natural',
        slogan: 'Tu Santuario Personal, Revestido de Calidez',
        examples: [
            { imgSrc: 'https://images.unsplash.com/photo-1625621422479-11029c3139ae?q=80&w=1965&auto=format&fit=crop', title: 'Vanidad Flotante de Teca', description: 'Una pieza central que combina la resistencia a la humedad de la teca con un diseño minimalista y elegante.'},
            { imgSrc: 'https://images.unsplash.com/photo-1616238268423-a8321773a45d?q=80&w=1964&auto=format&fit=crop', title: 'Gabinete de Almacenamiento Vertical', description: 'Soluciones inteligentes para espacios reducidos, ofreciendo un amplio almacenamiento sin sacrificar el estilo.'},
            { imgSrc: 'https://images.unsplash.com/photo-1593902341259-882f254f15f9?q=80&w=1964&auto=format&fit=crop', title: 'Acentos de Pared con Listones de Cedro', description: 'Crea una pared de acento tipo spa que añade textura, aroma y una sensación de lujo natural a tu baño.'},
        ]
    },
    estudios: {
        title: 'Estudios y Oficinas en Casa',
        slogan: 'Espacios que Inspiran Productividad',
        examples: [
            { imgSrc: 'https://images.unsplash.com/photo-1497215728101-856f4ea42174?q=80&w=2070&auto=format&fit=crop', title: 'Escritorio y Estantería Integrados', description: 'Un espacio de trabajo unificado y a medida que maximiza la superficie y el almacenamiento vertical.'},
            { imgSrc: 'https://images.unsplash.com/photo-1524758631624-e2822e304c36?q=80&w=2070&auto=format&fit=crop', title: 'Pared de Almacenamiento a Medida', description: 'Organiza tus libros y documentos con un sistema flexible que se integra perfectamente a la pared.'},
            { imgSrc: 'https://images.unsplash.com/photo-1586023492125-27b2c045efd7?q=80&w=1974&auto=format&fit=crop', title: 'Gabinetes Bajos de Almacenamiento', description: 'Una solución elegante para ocultar impresoras y suministros, manteniendo una superficie de trabajo limpia y ordenada.'},
        ]
    },
    gatos: {
        title: 'Enriquecimiento para Gatos',
        slogan: 'Diseño que Ronronea de Felicidad',
        examples: [
            { imgSrc: 'https://images.unsplash.com/photo-1598939748535-a78203f563d7?q=80&w=1974&auto=format&fit=crop', title: 'Autopista de Pared para Gatos', description: 'Un circuito de estantes, puentes y postes rascadores que satisface su necesidad de explorar en las alturas.'},
            { imgSrc: 'https://images.unsplash.com/photo-1610121183358-da47c0b6e115?q=80&w=1974&auto=format&fit=crop', title: 'Torre de Actividades Escultural', description: 'Una pieza de arte funcional que sirve como torre de observación y rascador, integrándose como un mueble más.'},
            { imgSrc: 'https://images.unsplash.com/photo-1588012885473-39294921f450?q=80&w=1974&auto=format&fit=crop', title: 'Mueble con Rascador Integrado', description: 'Una estación de descanso y juego que se fusiona con un mueble auxiliar, manteniendo el orden y la estética.'},
        ]
    }
};

const ServiceDetailPage = ({ title, slogan, examples, onLogin, className, onBack }: { title: string, slogan: string, examples: ServiceExample[], onLogin: () => void, className?: string, onBack: () => void }) => (
    <div className={`page-container ${className || ''}`}>
        <div className="service-detail-header">
            <h1>{title}</h1>
            <p>{slogan}</p>
        </div>
        <a href="#" onClick={(e) => { e.preventDefault(); onBack(); }} className="back-to-services">← Volver a todos los servicios</a>
        <div className="page-content">
            <h3>Ejemplos de Transformación</h3>
            <div className="examples-grid">
                {examples.map((ex, i) => (
                    <div className="example-card" key={i}>
                        <img src={ex.imgSrc} alt={ex.title} className="example-image" />
                        <div className="example-content">
                            <h4>{ex.title}</h4>
                            <p>{ex.description}</p>
                        </div>
                    </div>
                ))}
            </div>
            <div className="cta-section">
                <h2>¿Inspirado para transformar tu espacio?</h2>
                <button className="cta-button" onClick={onLogin}>Comienza tu Diseño Ahora</button>
            </div>
        </div>
    </div>
);

const SalasServicePage = ({ onLogin, onBack }: { onLogin: () => void, onBack: () => void }) => <ServiceDetailPage {...serviceData.salas} onLogin={onLogin} className="salas-service" onBack={onBack} />;
const HabitacionServicePage = ({ onLogin, onBack }: { onLogin: () => void, onBack: () => void }) => <ServiceDetailPage {...serviceData.habitacion} onLogin={onLogin} className="habitacion-service" onBack={onBack} />;
const CocinasServicePage = ({ onLogin, onBack }: { onLogin: () => void, onBack: () => void }) => <ServiceDetailPage {...serviceData.cocinas} onLogin={onLogin} className="cocinas-service" onBack={onBack} />;
const BanosServicePage = ({ onLogin, onBack }: { onLogin: () => void, onBack: () => void }) => <ServiceDetailPage {...serviceData.banos} onLogin={onLogin} className="banos-service" onBack={onBack} />;
const EstudiosServicePage = ({ onLogin, onBack }: { onLogin: () => void, onBack: () => void }) => <ServiceDetailPage {...serviceData.estudios} onLogin={onLogin} className="estudios-service" onBack={onBack} />;
const GatosServicePage = ({ onLogin, onBack }: { onLogin: () => void, onBack: () => void }) => <ServiceDetailPage {...serviceData.gatos} onLogin={onLogin} className="gatos-service" onBack={onBack} />;


const AboutPage = () => (
   <div className="page-container">
    <div className="page-header">
      <h1>Sobre Maderarte</h1>
      <p>Pasión por la madera, compromiso con el diseño.</p>
    </div>
    <div className="page-content about-content">
      <div className="about-section">
        <h3>Nuestra Filosofía</h3>
        <p>En Maderarte, creemos que los muebles son más que objetos; son el alma de un espacio. Combinamos técnicas de carpintería tradicionales con diseño contemporáneo para crear piezas que cuentan una historia. Cada veta de la madera, cada unión y cada acabado es un testimonio de nuestro amor por el oficio y nuestro compromiso con la calidad duradera.</p>
      </div>
      <div className="about-section">
        <h3>Nuestra Misión</h3>
        <p>Nuestra misión es transformar tus ideas en realidad tangible, creando espacios funcionales y estéticamente inspiradores a través del diseño de mobiliario en madera. Buscamos la excelencia en cada proyecto, asegurando la satisfacción de nuestros clientes y el respeto por el medio ambiente utilizando maderas de fuentes sostenibles.</p>
      </div>
      <div className="about-section team-section">
        <h3>Conoce al Equipo</h3>
        <div className="team-grid">
          <div className="team-member">
            <div className="team-photo-placeholder"></div>
            <h4>Elena Robles</h4>
            <h5>Fundadora & Diseñadora Principal</h5>
            <p>Con una visión que une arquitectura y naturaleza, Elena lidera cada proyecto con creatividad y una atención meticulosa al detalle.</p>
          </div>
          <div className="team-member">
             <div className="team-photo-placeholder"></div>
            <h4>Javier Mendoza</h4>
            <h5>Maestro Artesano</h5>
            <p>Con más de 30 años de experiencia, Javier convierte los diseños en obras de arte, dominando la madera con una habilidad inigualable.</p>
          </div>
        </div>
      </div>
    </div>
  </div>
);

const ContactPage = () => {
    const [submitted, setSubmitted] = useState(false);
    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        setSubmitted(true);
    };

    return (
     <div className="page-container">
        <div className="page-header">
          <h1>Ponte en Contacto</h1>
          <p>¿Tienes una idea o una pregunta? Estamos aquí para ayudarte a darle forma.</p>
        </div>
        <div className="page-content">
            <div className="contact-layout">
                <div className="contact-info">
                    <h3>Información de Contacto</h3>
                    <p><strong>Dirección:</strong> Av. de la Madera 123, Ciudad Creativa, 45678</p>
                    <p><strong>Teléfono:</strong> +34 912 345 678</p>
                    <p><strong>Email:</strong> hola@maderarte.design</p>
                    <p><strong>Horario:</strong> Lunes a Viernes, de 9:00 a 18:00</p>
                </div>
                <div className="contact-form-container">
                    {submitted ? (
                        <div className="form-success">
                            <h4>¡Gracias por tu mensaje!</h4>
                            <p>Hemos recibido tu consulta y nos pondremos en contacto contigo a la brevedad.</p>
                        </div>
                    ) : (
                        <form className="contact-form" onSubmit={handleSubmit}>
                            <h3>Envíanos un Mensaje</h3>
                            <div className="form-group">
                                <label htmlFor="name">Nombre</label>
                                <input type="text" id="name" name="name" required />
                            </div>
                            <div className="form-group">
                                <label htmlFor="email">Email</label>
                                <input type="email" id="email" name="email" required />
                            </div>
                            <div className="form-group">
                                <label htmlFor="message">Mensaje</label>
                                <textarea id="message" name="message" rows={5} required></textarea>
                            </div>
                            <button type="submit" className="cta-button">Enviar Mensaje</button>
                        </form>
                    )}
                </div>
            </div>
        </div>
    </div>
    );
};

const PrivatePage = ({ state, onSelectSpace, onFileChange, onAnalyzeSpace, onRefineImage, onRequestQuote, onReset, onCatDetailsSubmit, onCatCountChange, onCatDetailChange, onBack }: {
  state: AppState,
  onSelectSpace: (space: string) => void,
  onFileChange: (e: React.ChangeEvent<HTMLInputElement>) => void,
  onAnalyzeSpace: () => void,
  onRefineImage: (prompt: string) => void,
  onRequestQuote: () => void,
  onReset: () => void,
  onCatDetailsSubmit: (cats: CatDetails[]) => void,
  onCatCountChange: (count: number) => void,
  onCatDetailChange: (index: number, field: 'size' | 'age', value: string) => void,
  onBack: () => void
}) => {
    const isCatFlow = state.selectedSpace === 'Espacio para Gatos';
    const steps = isCatFlow
      ? ["Seleccionar Espacio", "Detalles Felinos", "Cargar Fotos", "Diseño y Refinamiento", "Confirmación"]
      : ["Seleccionar Espacio", "Cargar Fotos", "Diseño y Refinamiento", "Confirmación"];

    const renderStepContent = () => {
        const step = state.designStep;
        
        if (step === 1) {
            return <SelectSpace onSelect={onSelectSpace} />;
        }
        
        if (isCatFlow) {
            // Cat Flow: 1=Select, 2=Details, 3=Upload, 4=Studio, 5=Confirm
            switch (step) {
                case 2: return <CatDetailsStep 
                    cats={state.cats} 
                    onCatCountChange={onCatCountChange} 
                    onCatDetailChange={onCatDetailChange} 
                    onSubmit={onCatDetailsSubmit} 
                    onBack={onBack}
                />;
                case 3: return <UploadStep state={state} onFileChange={onFileChange} onAnalyze={onAnalyzeSpace} onBack={onBack} stepNumber={3} />;
                case 4: return <DesignStudio state={state} onRefine={onRefineImage} onQuote={onRequestQuote} onBack={onBack} stepNumber={4} />;
                case 5: return <Confirmation onReset={onReset} />;
                default: return <SelectSpace onSelect={onSelectSpace} />;
            }
        } else {
            // Normal Flow: 1=Select, 2=Upload, 3=Studio, 4=Confirm
            switch (step) {
                case 2: return <UploadStep state={state} onFileChange={onFileChange} onAnalyze={onAnalyzeSpace} onBack={onBack} stepNumber={2} />;
                case 3: return <DesignStudio state={state} onRefine={onRefineImage} onQuote={onRequestQuote} onBack={onBack} stepNumber={3} />;
                case 4: return <Confirmation onReset={onReset} />;
                default: return <SelectSpace onSelect={onSelectSpace} />;
            }
        }
    };

    return (
        <div className="private-page">
            <Stepper currentStep={state.designStep} steps={steps} />
            {state.isLoading && <LoadingOverlay />}
            {renderStepContent()}
            {state.error && <div className="error-message">{state.error}</div>}
        </div>
    );
};

const Stepper = ({ currentStep, steps }: { currentStep: number, steps: string[] }) => {
    return (
        <div className="stepper" role="navigation" aria-label="Progreso del diseño">
            {steps.map((step, index) => {
                const stepNumber = index + 1;
                let stepClass = "step-item";
                let statusText = '';
                if (stepNumber < currentStep) {
                    stepClass += " completed";
                    statusText = 'completado';
                } else if (stepNumber === currentStep) {
                    stepClass += " active";
                    statusText = 'actual';
                } else {
                    statusText = 'siguiente';
                }

                return (
                    <div className={stepClass} key={step} style={{ width: `${100 / steps.length}%` }}>
                        <div className="step-number" aria-hidden="true">{stepNumber < currentStep ? '✔' : stepNumber}</div>
                        <div className="step-label" aria-current={stepNumber === currentStep ? "step" : undefined}>
                            {step}
                            <span className="visually-hidden">, Paso {stepNumber}, {statusText}</span>
                        </div>
                    </div>
                );
            })}
        </div>
    );
};

const SelectSpace = ({ onSelect }: { onSelect: (space: string) => void }) => (
    <div className="step-container">
        <h2>Bienvenido a tu Estudio de Diseño</h2>
        <p>¿Qué espacio te gustaría transformar hoy?</p>
        <div className="space-selection">
            <button onClick={() => onSelect('Sala')}>
                <svg aria-hidden="true" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v3"/><path d="M2 11h20"/><path d="M4 11v5a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5"/></svg>
                <span>Sala</span>
            </button>
             <button onClick={() => onSelect('Habitación')}>
                <svg aria-hidden="true" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M2 12h20v6H2z"/><path d="M2 10V6a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v4H2z"/><path d="M6 8v2"/><path d="M18 8v2"/></svg>
                <span>Habitación</span>
            </button>
            <button onClick={() => onSelect('Estudio')}>
                <svg aria-hidden="true" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>
                <span>Estudio</span>
            </button>
            <button onClick={() => onSelect('Cocina')}>
                 <svg aria-hidden="true" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 14H3v6a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-6z"/><path d="M3 14V4a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10"/><path d="M15 8v2"/><path d="M9 8v2"/></svg>
                <span>Cocina</span>
            </button>
            <button onClick={() => onSelect('Baño')}>
                <svg aria-hidden="true" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 10H3v8a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-8z"/><path d="M5 10V7a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v3"/><path d="M7 15v-3"/></svg>
                <span>Baño</span>
            </button>
            <button onClick={() => onSelect('Espacio para Gatos')} className="cat-button">
                 <svg aria-hidden="true" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5c.67 0 1.35.09 2 .26 1.78-2 5.03-2.84 6.42-2.08.39.21.61.62.58.97-.02.2-.12.39-.28.52-1.14.93-2.24 2.44-2.65 4.31a9.23 9.23 0 0 1-1.25 4.3-1.001 1.001 0 0 1-1.5-.42 1 1 0 0 0-1.6- .33c-1.22.95-2.64 1.4-4.1 1.4-4.42 0-8-3.58-8-8s3.58-8 8-8c.46 0 .91.04 1.35.12"/></svg>
                <span>Espacio para Gatos</span>
            </button>
        </div>
    </div>
);

const CatDetailsStep = ({ cats, onCatCountChange, onCatDetailChange, onSubmit, onBack }: {
  cats: CatDetails[],
  onCatCountChange: (count: number) => void,
  onCatDetailChange: (index: number, field: 'size' | 'age', value: string) => void,
  onSubmit: (cats: CatDetails[]) => void,
  onBack: () => void,
}) => {
  const isFormComplete = cats.every(cat => cat.size && cat.age);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (isFormComplete) {
      onSubmit(cats);
    }
  };

  return (
    <div className="step-container cat-details-step">
      <h2>Paso 2: Detalles Felinos</h2>
      <p>Cuéntanos más sobre tus compañeros para crear el espacio perfecto para ellos.</p>
      <form onSubmit={handleSubmit}>
        <div className="form-group">
          <label htmlFor="cat-count">¿Cuántos gatos tienes?</label>
          <select 
            id="cat-count" 
            value={cats.length} 
            onChange={(e) => onCatCountChange(parseInt(e.target.value, 10))}
          >
            {[1, 2, 3, 4, 5].map(n => <option key={n} value={n}>{n}</option>)}
          </select>
        </div>

        {cats.map((cat, index) => (
          <div className="cat-form-group" key={index}>
            <h4>Gato {index + 1}</h4>
            <div className="form-row">
              <div className="form-group">
                <label htmlFor={`cat-size-${index}`}>Tamaño</label>
                <select 
                  id={`cat-size-${index}`} 
                  value={cat.size} 
                  onChange={(e) => onCatDetailChange(index, 'size', e.target.value)}
                  required
                >
                  <option value="" disabled>Selecciona un tamaño</option>
                  <option value="pequeño">Pequeño (hasta 4kg)</option>
                  <option value="mediano">Mediano (4-6kg)</option>
                  <option value="grande">Grande (más de 6kg)</option>
                </select>
              </div>
              <div className="form-group">
                <label htmlFor={`cat-age-${index}`}>Edad</label>
                <select 
                  id={`cat-age-${index}`} 
                  value={cat.age} 
                  onChange={(e) => onCatDetailChange(index, 'age', e.target.value)}
                  required
                >
                  <option value="" disabled>Selecciona una edad</option>
                  <option value="joven">Joven (0-2 años)</option>
                  <option value="adulto">Adulto (2-10 años)</option>
                  <option value="viejito">Viejito (más de 10 años)</option>
                </select>
              </div>
            </div>
          </div>
        ))}
        <div className="step-navigation">
            <button type="button" className="secondary-button" onClick={onBack}>Volver</button>
            <button type="submit" className="cta-button" disabled={!isFormComplete}>Continuar a Cargar Fotos</button>
        </div>
      </form>
    </div>
  );
};


const UploadStep = ({ state, onFileChange, onAnalyze, onBack, stepNumber }: { state: AppState, onFileChange: (e: React.ChangeEvent<HTMLInputElement>) => void, onAnalyze: () => void, onBack: () => void, stepNumber: number }) => (
    <div className="step-container">
        <h2>Paso {stepNumber}: Fotografía tu {state.selectedSpace}</h2>
        <div className="instructions">
            <p>Para obtener un análisis preciso, sigue estos consejos:</p>
            <ol>
                <li><strong>Descarga y prepara:</strong> Descarga e imprime nuestro objeto de referencia.</li>
                <li><strong>Despeja el espacio:</strong> Retira todos los objetos móviles (sillas, mesas pequeñas, decoración) para tener una vista clara de la habitación.</li>
                <li><strong>Ubica la referencia:</strong> Coloca el objeto de referencia en el suelo, preferiblemente contra una pared principal o en una esquina bien iluminada.</li>
                <li><strong>Captura desde múltiples ángulos:</strong> Toma varias fotos desde diferentes ángulos para darnos una vista completa del espacio. Es crucial que el objeto de referencia sea claramente visible en <strong>TODAS</strong> las fotos.</li>
            </ol>
            <a href="/docs/referencia_escuadra_CSI_escalera.pdf" download="referencia_maderarte.pdf" className="secondary-button">Descargar Referencia</a>
        </div>
        <div className="upload-area">
          <label htmlFor="file-upload" className="file-upload-label">
            {state.uploadedImages.length > 0 ? `Archivos seleccionados: ${state.uploadedImages.length}` : 'Seleccionar Imágenes'}
          </label>
          <input id="file-upload" type="file" accept="image/*" onChange={onFileChange} multiple />
          {state.uploadedImageBase64s.length > 0 && (
            <div className="image-preview-gallery">
              {state.uploadedImageBase64s.map((base64, index) => (
                <img key={index} src={`data:image/jpeg;base64,${base64}`} alt={`Vista previa ${index + 1}`} className="image-preview-item"/>
              ))}
            </div>
          )}
        </div>
        <div className="step-navigation">
          <button className="secondary-button" onClick={onBack}>Volver</button>
          <button className="cta-button" onClick={onAnalyze} disabled={state.uploadedImages.length === 0}>Analizar Espacio</button>
        </div>
    </div>
);

const DesignStudio = ({ state, onRefine, onQuote, onBack, stepNumber }: { state: AppState, onRefine: (p: string) => void, onQuote: () => void, onBack: () => void, stepNumber: number }) => {
    const [refinePrompt, setRefinePrompt] = useState('');
    const { aiResponse } = state;

    const handleRefineSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        if(refinePrompt.trim()) onRefine(refinePrompt);
    };

    const handleSuggestionClick = (description: string) => {
      onRefine(description);
    };

    return (
    <div className="design-studio">
        <h2>Paso {stepNumber}: Visualiza y Refina tu Diseño</h2>
        <div className="studio-layout">
            <div className="studio-panel image-panel">
                <h3>Tu Espacio Transformado</h3>
                <p>Esta es una interpretación de la IA basada en tus peticiones. ¿Qué te gustaría cambiar?</p>
                <img 
                    src={state.editedImageBase64 ? `data:image/jpeg;base64,${state.editedImageBase64}` : `data:image/jpeg;base64,${state.uploadedImageBase64s[0]}`} 
                    alt="Diseño generado" 
                    className="generated-image"
                />
                <form className="refine-form" onSubmit={handleRefineSubmit}>
                    <input 
                        type="text" 
                        value={refinePrompt}
                        onChange={(e) => setRefinePrompt(e.target.value)}
                        placeholder="Ej: 'Añade una librería de nogal en la pared derecha'"
                        aria-label="Prompt para refinar el diseño"
                    />
                    <button type="submit" disabled={!refinePrompt.trim()}>Refinar</button>
                </form>
            </div>
            <div className="studio-panel details-panel">
                <h3>Análisis y Sugerencias de la IA</h3>
                {aiResponse && <>
                    <div className="detail-section">
                        <h4>Dimensiones Estimadas</h4>
                        <p>{aiResponse.dimensions}</p>
                    </div>
                     <div className="detail-section">
                        <h4>Plano 2D</h4>
                        <div className="svg-container" dangerouslySetInnerHTML={{ __html: sanitizeSVG(aiResponse.floorPlan) }} />
                    </div>
                    <div className="detail-section">
                        <h4>Estilo Actual</h4>
                        <p>{aiResponse.currentStyle}</p>
                    </div>
                    <div className="detail-section">
                        <h4>Sugerencias de Diseño</h4>
                        {aiResponse.suggestions.map((s, i) => (
                          <div key={i} className="suggestion-card" onClick={() => handleSuggestionClick(s.description)}>
                            <h5>{s.styleName}</h5>
                            <p>{s.description}</p>
                          </div>
                        ))}
                    </div>
                </>}
                <div className="step-navigation">
                    <button className="secondary-button" onClick={onBack}>Volver</button>
                    <button className="cta-button" onClick={onQuote}>¡Me encanta! Solicitar Cotización</button>
                </div>
            </div>
        </div>
    </div>
)};

const Confirmation = ({ onReset }: { onReset: () => void }) => (
    <div className="step-container text-center">
        <h2>¡Diseño Enviado!</h2>
        <p>Gracias por confiar en nosotros. Tu propuesta ha sido enviada a nuestro equipo de producción.</p>
        <p>En breve nos pondremos en contacto contigo con una cotización detallada y los siguientes pasos.</p>
        <button className="cta-button" onClick={onReset}>Crear un Nuevo Diseño</button>
    </div>
);

const LoadingOverlay = () => {
    const messages = [
        'Tallando tus ideas en madera...',
        'Dando forma a tu espacio...',
        'Un momento mientras la creatividad fluye...',
        'Analizando las vetas del diseño...',
        'Ensamblando los detalles...'
    ];
    const [currentMessage, setCurrentMessage] = useState(messages[0]);
    const messageId = "loading-message";

    useEffect(() => {
        const intervalId = setInterval(() => {
            setCurrentMessage(prev => {
                const currentIndex = messages.indexOf(prev);
                const nextIndex = (currentIndex + 1) % messages.length;
                return messages[nextIndex];
            });
        }, 2500);

        return () => clearInterval(intervalId);
    }, []);

    return (
        <div
            className="loading-overlay"
            role="dialog"
            aria-modal="true"
            aria-labelledby={messageId}
            aria-live="assertive"
        >
            <div className="spinner"></div>
            <p id={messageId}>{currentMessage}</p>
        </div>
    );
};

const Footer = () => (
  <footer>
    <p>&copy; 2024 Maderarte. Todos los derechos reservados.</p>
  </footer>
);


// --- Mount App ---
const container = document.getElementById('root');
const root = createRoot(container!);
root.render(<App />);
