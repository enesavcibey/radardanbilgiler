import type { Metadata,Viewport } from "next";
import "./globals.css";
export const metadata:Metadata={title:"OranRadar",description:"Futbol ve basketbol maçlarında maç öncesi oran karşılaştırma ekranı.",applicationName:"OranRadar",appleWebApp:{capable:true,statusBarStyle:"black",title:"OranRadar"},formatDetection:{telephone:false},icons:{icon:"/favicon.svg",shortcut:"/favicon.svg",apple:"/favicon.svg"}};
export const viewport:Viewport={width:"device-width",initialScale:1,viewportFit:"cover",themeColor:"#07110f"};
export default function RootLayout({children}:Readonly<{children:React.ReactNode}>){return <html lang="tr"><body>{children}</body></html>}
