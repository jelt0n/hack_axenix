import {useEffect,useState} from 'react';
import {api} from './api';
import useTransformationPreview from './useTransformationPreview';
import type {ExtractionPreview,GraphNode,MethodGraph,Project} from './types';

export default function ExtractMethodPanel({project,graph,selected,disabled,onApply,onConflict}:{
  project:Project; graph:MethodGraph|null; selected:GraphNode|null; disabled:boolean;
  onApply:(preview:ExtractionPreview)=>Promise<void>; onConflict:()=>void;
}) {
  const container=graph?.containers?.find(item=>item.kind==='method');
  const count=container?.size??0;
  const [methodName,setMethodName]=useState('extractedPart');
  const [startIndex,setStart]=useState(0);
  const [endIndex,setEnd]=useState(1);
  useEffect(()=>{setStart(0);setEnd(Math.min(2,count));},[graph?.methodId]);
  useEffect(()=>{
    if(selected?.containerId===container?.id && selected?.index!==undefined){setStart(selected.index);setEnd(selected.index+1);}
  },[selected?.id,container?.id]);
  const identity=`${project.id}:${project.revision}:${graph?.methodId}:${startIndex}:${endIndex}:${methodName}:${disabled}`;
  const {preview,busy,error,prepare,cancel}=useTransformationPreview<ExtractionPreview>(identity,onConflict);
  const valid=preview?.projectId===project.id && preview.sourceRevision===project.revision
    && preview.methodId===graph?.methodId && preview.methodName===methodName
    && preview.startIndex===startIndex && preview.endIndex===endIndex;

  const label=(index:number)=>{
    const node=graph?.nodes.find(item=>item.containerId===container?.id&&item.index===index);
    return `${index+1} · ${node?.code.slice(0,85)??'Конструкция управления'}`;
  };
  return <section className="extract-method-panel" aria-label="Выделение метода">
    <strong>Выделение метода</strong><p>Выберите непрерывный фрагмент в теле метода. Поддержаны операции с примитивами и не более одного результата.</p>
    <fieldset disabled={disabled} className="extract-fields">
      <label>Имя нового метода<input aria-label="Имя нового метода" value={methodName} maxLength={80} onChange={event=>setMethodName(event.target.value)}/></label>
      <label>Первая операция<select aria-label="Первая операция" value={startIndex} onChange={event=>setStart(Number(event.target.value))}>
        {Array.from({length:count},(_,index)=><option key={index} value={index}>{label(index)}</option>)}</select></label>
      <label>Последняя операция<select aria-label="Последняя операция" value={endIndex} onChange={event=>setEnd(Number(event.target.value))}>
        {Array.from({length:count},(_,index)=><option key={index} value={index+1}>{label(index)}</option>)}</select></label>
      <button className="button secondary" disabled={busy||!methodName.trim()||startIndex>=endIndex||endIndex>count||!count}
        onClick={()=>void prepare(()=>api.previewExtraction(project.id,project.revision,{methodId:graph!.methodId,startIndex,endIndex,methodName}, project.fileId))}>{busy?'Готовим…':'Предпросмотр выделения'}</button>
    </fieldset>
    {error&&<p role="alert">{error}</p>}
    {preview&&valid&&!disabled&&<div role="dialog" aria-label="Предпросмотр выделения метода" className="branch-preview">
      <p>Параметры: {preview.parameters.map(item=>`${item.type} ${item.name}`).join(', ')||'нет'}.
        Возвращаемый тип: {preview.returnType}. {preview.outputName?`Результат: ${preview.outputName}.`:'Возвращаемых значений нет.'}</p>
      <div className="branch-preview-code"><div><h3>Выбранный фрагмент</h3><pre aria-label="Выбранный фрагмент">{preview.before}</pre></div>
        <div><h3>Замена вызовом</h3><pre aria-label="Замена фрагмента">{preview.after}</pre></div></div>
      <h3>Новый метод</h3><pre className="extract-new-method" aria-label="Новый метод">{preview.newMethod}</pre>
      <p>Подтверждение сохранит код и запустит проверку на сценариях из панели проверки поведения. Совпадение относится только к выполненным входам.</p>
      <div className="graph-edit-actions"><button className="button primary" onClick={()=>void onApply(preview)}>Выделить и проверить</button>
        <button className="button secondary" onClick={cancel}>Отмена</button></div>
    </div>}
  </section>;
}
